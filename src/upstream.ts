// HTTP JSON-RPC client for the upstream chain. Replaces transport.go +
// wsclient.go: the Worker speaks request/response fetch() instead of a
// long-lived WebSocket. Multiple URLs => failover (try in order on transport
// error), mirroring the Go --rpc comma-list semantics.
//
// Retry policy: public endpoints rate-limit by IP, and all Worker traffic
// egresses from Cloudflare's shared IPs, so bursts of 429s are routine. A
// failed pass over the URL list is retried with a short backoff — but only
// when the failure is transient (transport error, HTTP 429, HTTP 5xx). A
// non-retryable HTTP status (e.g. 400) fails over within the pass and then
// throws immediately.

import type { JsonValue, RpcResponse } from './rpc'

// Delay before each retry pass over the URL list (total 2 extra passes).
const RETRY_BACKOFF_MS = [250, 750]

// Reads packed into one batch POST. Public endpoints cap batch sizes (commonly
// 100); a request over the cap fails over to the next URL like any other error.
const MAX_BATCH = 100

export interface BatchCall {
  method: string
  params: unknown[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class Upstream {
  constructor(private readonly urls: string[]) {
    if (urls.length === 0) throw new Error('no upstream RPC configured')
  }

  /**
   * POST a JSON-RPC body, failing over across URLs and retrying with backoff.
   * `expectArray` selects batch shape validation: an endpoint that answers a
   * batch with a bare object (no batch support / batch-size cap) fails over to
   * the next URL instead of being returned as a mis-shaped success.
   */
  private async post(body: string, label: string, expectArray = false): Promise<unknown> {
    let lastErr: unknown
    for (let round = 0; ; round++) {
      let retryable = false
      for (const url of this.urls) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
          if (!r.ok) {
            lastErr = new Error(`upstream HTTP ${r.status}`)
            if (r.status === 429 || r.status >= 500) retryable = true
            continue // rate-limited or down -> next URL (failover)
          }
          const j: unknown = await r.json()
          if (expectArray && !Array.isArray(j)) {
            lastErr = new Error(`batch not supported (${url})`)
            continue // shape mismatch is permanent for this URL -> failover only
          }
          return j
        } catch (e) {
          lastErr = e // transport error -> try next URL (failover)
          retryable = true
        }
      }
      if (!retryable || round >= RETRY_BACKOFF_MS.length) break
      await sleep(RETRY_BACKOFF_MS[round] ?? 0)
    }
    throw new Error(`${label}: ${String(lastErr)}`)
  }

  /**
   * Issue many JSON-RPC calls as batch POSTs (MAX_BATCH per request) — the
   * Workers subrequest cap counts HTTP requests, not RPC calls, so this is how
   * a lazy fork stays inside the Free plan's 50-subrequest budget. Returns one
   * response per call, index-aligned; a call the endpoint failed to answer gets
   * a synthesized error response (never a hole).
   */
  async batch(calls: BatchCall[]): Promise<RpcResponse[]> {
    const out: RpcResponse[] = new Array(calls.length)
    for (let base = 0; base < calls.length; base += MAX_BATCH) {
      const chunk = calls.slice(base, base + MAX_BATCH)
      const body = JSON.stringify(
        chunk.map((c, i) => ({ jsonrpc: '2.0', id: base + i, method: c.method, params: c.params })),
      )
      const arr = (await this.post(body, `upstream batch(${chunk.length})`, true)) as RpcResponse[]
      for (const resp of arr) {
        const idx = typeof resp?.id === 'number' ? resp.id : -1
        if (idx >= base && idx < base + chunk.length) out[idx] = resp
      }
      for (let i = base; i < base + chunk.length; i++) {
        if (!out[i]) {
          out[i] = {
            jsonrpc: '2.0',
            id: i,
            error: { code: -32603, message: 'missing batch response' },
          }
        }
      }
    }
    return out
  }

  /** Issue a JSON-RPC call, returning the full response (result OR error). */
  async call(method: string, params: unknown[]): Promise<RpcResponse> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    return (await this.post(body, `upstream ${method}`)) as RpcResponse
  }

  /** Issue a call and return its `result`, throwing on an RPC-level error. */
  async callResult(method: string, params: unknown[]): Promise<JsonValue> {
    const resp = await this.call(method, params)
    if (resp.error) throw new Error(`upstream ${method}: ${resp.error.message}`)
    return resp.result as JsonValue
  }

  /**
   * Forward a client JSON-RPC request to upstream and return the parsed
   * response. Used by the passthrough path for any method fakereum doesn't
   * special-case. The envelope is normalized (jsonrpc/id always present).
   */
  async forward(req: { method: string; params?: unknown; id?: unknown }): Promise<RpcResponse> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: req.id ?? 1,
      method: req.method,
      params: req.params ?? [],
    })
    return (await this.post(body, 'upstream forward')) as RpcResponse
  }
}
