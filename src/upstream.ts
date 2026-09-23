// HTTP JSON-RPC client for the upstream chain. Replaces transport.go +
// wsclient.go: the Worker speaks request/response fetch() instead of a
// long-lived WebSocket. Multiple URLs => failover (try in order on transport
// error), mirroring the Go --rpc comma-list semantics.
//
// Retry policy: public endpoints rate-limit by IP, and all Worker traffic
// egresses from Cloudflare's shared IPs, so bursts of 429s are routine — and
// some endpoints express the same refusal as 401/403 instead. A failed pass
// over the URL list is retried with a short backoff — but only when the
// failure is transient (transport error, HTTP 401/403/429, HTTP 5xx). A
// non-retryable HTTP status (e.g. 400) fails over within the pass and then
// throws immediately.

import type { JsonValue, RpcResponse } from './rpc'
import { toBigInt } from './lib/hex'

// Delay before each retry pass over the URL list (total 2 extra passes).
const RETRY_BACKOFF_MS = [250, 750]

// Reads packed into one batch POST. Public endpoints cap batch sizes (commonly
// 100); a request over the cap fails over to the next URL like any other error.
const MAX_BATCH = 100

// How long a URL sits out after a rate-limit/quota/transport failure. Public
// quotas are per-IP and all Worker traffic shares Cloudflare's egress IPs, so
// once an endpoint says "limit" it will keep saying it — skipping it saves a
// wasted subrequest per read while it cools down.
const COOLDOWN_MS = 30_000

// Monotonic head guard. A chain's head only grows, so the highest block number
// any URL has ever reported is a lower bound the real head always satisfies. A
// head read answering more than this many blocks BELOW that bound came from a
// backend that has stopped following the chain (rpc.ordofi.network fronts two
// nodes, one of them frozen ~600 blocks back) — fail over and bench the URL.
// The margin absorbs honest skew between healthy nodes: 64 blocks is ~7s on a
// 9-block/s Orbit chain and ~16s on Arbitrum One; a healthy node is never that
// far behind, a frozen one is past it within seconds.
const STALE_HEAD_BLOCKS = 64n

export interface BatchCall {
  method: string
  params: unknown[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A JSON-RPC-level error that is really the PROVIDER refusing service (rate
 * limit / quota / capacity) rather than the chain answering. Some providers
 * (1rpc among them) return these as HTTP 200 + error body, which must fail
 * over to the next URL instead of being surfaced as the "answer".
 */
export function isProviderLimitError(
  e: { code?: number; message?: string } | undefined | null,
): boolean {
  if (!e) return false
  if (e.code === -32005 || e.code === 429) return true // EIP-1474 limit exceeded / http-ish
  // drpc's router failing to place the call: code 12, "Can't route your request
  // to suitable provider". Transient (about one call in six on state-override
  // eth_call through the sandbox's egress) and never the chain's answer, so it
  // is a fail-over signal like a quota refusal: next URL, bench this one briefly.
  if (e.code === 12) return true
  const m = (e.message ?? '').toLowerCase()
  if (/can.?t route (your )?request|no suitable provider|suitable provider/.test(m)) return true
  return /rate.?limit|usage limit|too many request|quota|over capacity|reached.*limit|limit (exceeded|reached)|unauthorized|api.?key/.test(
    m,
  )
}

/**
 * A JSON-RPC-level error saying the PROVIDER refuses this METHOD — some free
 * endpoints disable compute methods on their public URL (meowrpc answers
 * eth_call with HTTP 200 + -32000 "The method eth_call is not supported.")
 * That is provider policy, not the chain's answer: fail over to the next URL.
 * Only if every URL refuses is the refusal returned as the real answer (a
 * passthrough method like debug_* may genuinely not exist anywhere).
 *
 * Also covers a provider refusing a request SHAPE on policy grounds:
 * publicnode's free tier answers eth_getLogs without an address filter with
 * HTTP 200 + non-standard -32701 "Please specify an address in your request
 * or, to remove restrictions, order a dedicated full node". That used to be
 * returned to the caller as the chain's answer whenever the URLs ahead of it
 * were benched. It lands here (per-method skip) rather than in
 * isProviderLimitError, whose 30s bench would take the URL out for every
 * method although it still serves eth_call & co. fine.
 */
export function isMethodUnsupportedError(
  e: { code?: number; message?: string } | undefined | null,
): boolean {
  if (!e) return false
  if (e.code === -32601) return true // official "method not found"
  if (e.code === -32701) return true // publicnode: request shape refused by policy
  const m = (e.message ?? '').toLowerCase()
  if (/specify an address|dedicated (full )?node/.test(m)) return true
  return /\bmethod\b.{0,60}\b(not supported|unsupported|not available|not allowed|not enabled|disabled|does not exist|not found|not whitelisted)/.test(
    m,
  )
}

/**
 * The chain head a response reports, when the request was a head read:
 * eth_blockNumber, or eth_getBlockByNumber at latest/pending. Undefined for
 * anything else (fixed blocks, other methods, errors, malformed results).
 */
export function headOfResponse(method: string, params: unknown[], resp: RpcResponse): bigint | undefined {
  if (!resp || resp.error || resp.result == null) return undefined
  try {
    if (method === 'eth_blockNumber') {
      return typeof resp.result === 'string' ? toBigInt(resp.result) : undefined
    }
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0]
      if (typeof tag !== 'string') return undefined
      const t = tag.toLowerCase()
      if (t !== 'latest' && t !== 'pending') return undefined
      const num = (resp.result as { number?: unknown }).number
      return typeof num === 'string' ? toBigInt(num) : undefined
    }
  } catch {
    /* unparseable quantity: not a head we can judge */
  }
  return undefined
}

export class Upstream {
  // url -> timestamp until which it sits out (in-memory; resets on DO eviction)
  private readonly cooldown = new Map<string, number>()
  // Highest chain head any URL has reported (monotonic head guard; in-memory).
  private highWater = 0n
  // url -> methods the provider refused with a "not supported" error body.
  // Skipping saves the wasted subrequest on every later call; a success clears
  // the mark, so a provider re-enabling a method heals itself. (In-memory;
  // resets on DO eviction, like cooldown.)
  private readonly unsupported = new Map<string, Set<string>>()

  constructor(
    private readonly urls: string[],
    /** Per-fetch deadline. A hung connection otherwise holds the request — and, behind it, the sandbox write queue — indefinitely. */
    private readonly timeoutMs = 20_000,
  ) {
    if (urls.length === 0) throw new Error('no upstream RPC configured')
  }

  /**
   * URLs not currently cooling down; all of them when everything is benched.
   * With a method hint, URLs known to refuse that method are also skipped —
   * unless that would leave nothing, in which case they get re-probed.
   */
  private candidates(method?: string): string[] {
    const now = Date.now()
    let ok = this.urls.filter((u) => (this.cooldown.get(u) ?? 0) <= now)
    if (ok.length === 0) ok = this.urls
    if (method) {
      const sup = ok.filter((u) => !this.unsupported.get(u)?.has(method))
      if (sup.length > 0) return sup
    }
    return ok
  }

  private bench(url: string): void {
    this.cooldown.set(url, Date.now() + COOLDOWN_MS)
  }

  private markUnsupported(url: string, method: string): void {
    let s = this.unsupported.get(url)
    if (!s) this.unsupported.set(url, (s = new Set()))
    s.add(method)
  }

  /**
   * POST a JSON-RPC body, failing over across URLs and retrying with backoff.
   * `expectArray` selects batch shape validation: an endpoint that answers a
   * batch with a bare object (no batch support / batch-size cap) fails over to
   * the next URL instead of being returned as a mis-shaped success.
   */
  private async post(
    body: string,
    label: string,
    expectArray = false,
    method?: string,
    params: unknown[] = [],
  ): Promise<unknown> {
    let lastErr: unknown
    let lastUnsupported: RpcResponse | null = null
    // Stale-head answers seen this pass: returned (best one) only if EVERY URL
    // answers stale, which means the bound itself is wrong, not the nodes.
    let stale: Array<{ resp: RpcResponse; head: bigint }> = []
    for (let round = 0; ; round++) {
      let retryable = false
      stale = []
      const urls = this.candidates(method)
      for (const url of urls) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          })
          if (!r.ok) {
            lastErr = new Error(`upstream HTTP ${r.status}`)
            if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) {
              retryable = true
              this.bench(url)
            }
            continue // rate-limited/blocked or down -> next URL (failover)
          }
          const j: unknown = await r.json()
          if (expectArray) {
            if (!Array.isArray(j)) {
              lastErr = new Error(`batch not supported (${url})`)
              continue // shape mismatch is permanent for this URL -> failover only
            }
            const rs = j as RpcResponse[]
            if (
              rs.length > 0 &&
              rs.every((x) => isProviderLimitError(x?.error) || isMethodUnsupportedError(x?.error))
            ) {
              lastErr = new Error(`provider limit (${url}): ${rs[0]!.error!.message}`)
              retryable = true
              this.bench(url)
              continue // quota'd out (HTTP 200 + error bodies) -> next URL
            }
            return j
          }
          const resp = j as RpcResponse | null
          if (resp && isProviderLimitError(resp.error)) {
            lastErr = new Error(`provider limit (${url}): ${resp.error!.message}`)
            retryable = true
            this.bench(url)
            continue // quota'd out (HTTP 200 + error body) -> next URL
          }
          if (resp && isMethodUnsupportedError(resp.error)) {
            lastErr = new Error(`method unsupported (${url}): ${resp.error!.message}`)
            lastUnsupported = resp
            if (method) this.markUnsupported(url, method)
            continue // provider refuses this method, not benched -> next URL
          }
          if (resp && method) this.unsupported.get(url)?.delete(method)
          if (resp && method) {
            const head = headOfResponse(method, params, resp)
            if (head !== undefined) {
              if (head + STALE_HEAD_BLOCKS < this.highWater) {
                lastErr = new Error(
                  `stale head (${url}): ${head} is ${this.highWater - head} blocks behind the head already seen`,
                )
                stale.push({ resp, head })
                retryable = true
                this.bench(url)
                continue // backend stopped following the chain -> next URL
              }
              if (head > this.highWater) this.highWater = head
            }
          }
          return j
        } catch (e) {
          lastErr = e // transport error -> try next URL (failover)
          retryable = true
          this.bench(url)
        }
      }
      // Every configured URL reported a head below the bound: the bound is
      // what is wrong (a node once answered too high, or the chain rolled
      // back). Take the best answer and re-anchor on it instead of burning
      // retry passes on a guard that can no longer be satisfied. A partial
      // pass (some URLs benched or failing) is not proof: retry, so a healthy
      // URL coming off its bench can still answer.
      if (stale.length > 0 && stale.length === this.urls.length) {
        const best = stale.reduce((a, b) => (b.head > a.head ? b : a))
        this.highWater = best.head
        return best.resp
      }
      if (!retryable || round >= RETRY_BACKOFF_MS.length) break
      await sleep(RETRY_BACKOFF_MS[round] ?? 0)
    }
    if (stale.length > 0) {
      // Retries exhausted with some URLs stale and the rest failing outright:
      // an old head still beats no answer.
      const best = stale.reduce((a, b) => (b.head > a.head ? b : a))
      return best.resp
    }
    // Every URL refused the method (nothing serves it) -> the refusal IS the
    // answer; return it as a normal JSON-RPC error instead of throwing.
    if (lastUnsupported) return lastUnsupported
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
    return (await this.post(body, `upstream ${method}`, false, method, params)) as RpcResponse
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
    const params = Array.isArray(req.params) ? req.params : []
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: req.id ?? 1,
      method: req.method,
      params: req.params ?? [],
    })
    return (await this.post(body, 'upstream forward', false, req.method, params)) as RpcResponse
  }
}
