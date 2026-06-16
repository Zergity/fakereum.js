// HTTP JSON-RPC client for the upstream chain. Replaces transport.go +
// wsclient.go: the Worker speaks request/response fetch() instead of a
// long-lived WebSocket. Multiple URLs => failover (try in order on transport
// error), mirroring the Go --rpc comma-list semantics.

import type { JsonValue, RpcResponse } from './rpc'

export class Upstream {
  constructor(private readonly urls: string[]) {
    if (urls.length === 0) throw new Error('no upstream RPC configured')
  }

  /** Issue a JSON-RPC call, returning the full response (result OR error). */
  async call(method: string, params: unknown[]): Promise<RpcResponse> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    let lastErr: unknown
    for (const url of this.urls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        if (!r.ok) {
          lastErr = new Error(`upstream HTTP ${r.status}`)
          continue
        }
        return (await r.json()) as RpcResponse
      } catch (e) {
        lastErr = e // transport error -> try next URL (failover)
      }
    }
    throw new Error(`upstream ${method}: ${String(lastErr)}`)
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
    let lastErr: unknown
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: req.id ?? 1,
      method: req.method,
      params: req.params ?? [],
    })
    for (const url of this.urls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        if (!r.ok) {
          lastErr = new Error(`upstream HTTP ${r.status}`)
          continue
        }
        return (await r.json()) as RpcResponse
      } catch (e) {
        lastErr = e
      }
    }
    throw new Error(`upstream forward: ${String(lastErr)}`)
  }
}
