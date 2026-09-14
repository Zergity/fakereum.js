// The sandbox head's clock.
//
// The sandbox tip is "upstream@latest + overlay", so block.timestamp is
// whatever the upstream node's latest header says. That drifts from real time
// in two ways: a lagging failover node can sit tens of seconds behind the
// chain, and a chain that only mints blocks when there is traffic keeps its
// last header's time until the next tx lands. Contracts that compare
// block.timestamp against deadlines, vesting cliffs or auction ends then see a
// clock that stopped.
//
// Fix: the head's timestamp is the later of the upstream head's own timestamp
// and wall clock — the header a node mining on interval would carry. Every
// consumer sees it at once: locally executed txs and calls take it as the
// block context, forwarded eth_call / eth_estimateGas carry it as a geth
// `blockOverrides.time` (4th positional param), and eth_getBlockByNumber for
// the head tag reports it. The block number never moves — only the clock.

import type { RpcResponse } from './rpc'
import { toBigInt, toQuantity } from './lib/hex'

/** Synthetic head timestamp (seconds): max(upstream head time, wall clock). */
export function headTime(upstreamTime: bigint | undefined, nowMs: number = Date.now()): bigint {
  const now = BigInt(Math.floor(nowMs / 1000))
  return upstreamTime !== undefined && upstreamTime > now ? upstreamTime : now
}

/** Whether a block tag names the head: latest / pending / omitted. */
export function isHeadTag(tag: unknown): boolean {
  if (tag == null) return true
  if (typeof tag !== 'string') return false
  const t = tag.toLowerCase()
  return t === '' || t === 'latest' || t === 'pending'
}

/**
 * Patch a JSON block object (eth_getBlockByNumber result) so its `timestamp`
 * reads the synthetic head time. Anything that is not a block with a hex
 * timestamp is returned untouched.
 */
export function patchHeadBlock(result: unknown, nowMs: number = Date.now()): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const b = result as Record<string, unknown>
  const ts = b['timestamp']
  if (typeof ts !== 'string') return result
  let upstream: bigint
  try {
    upstream = toBigInt(ts)
  } catch {
    return result
  }
  return { ...b, timestamp: toQuantity(headTime(upstream, nowMs)) }
}

/**
 * A JSON-RPC error saying the node refused the request's ARITY, i.e. it does
 * not take the 4th `blockOverrides` positional. geth-family nodes answer
 * -32602 "too many arguments, want at most 3"; drpc's gateway answers -32601
 * "expect 1 required and 3 optional params for eth_call"; Nethermind/Besu say
 * a bare "Invalid params". A genuine chain answer (revert, gas) never looks
 * like this.
 */
export function isArityRejection(e: { code?: number; message?: string } | undefined | null): boolean {
  if (!e) return false
  const m = (e.message ?? '').toLowerCase()
  if (/too many arguments|optional params|invalid (json ?rpc )?param/.test(m)) return true
  return e.code === -32602
}

// How long a method keeps being forwarded WITHOUT blockOverrides after the
// upstream refused the 4-param shape. Long enough that a chain served only by
// nodes lacking the feature does not pay a wasted subrequest per call; short
// enough that a failover to a capable node picks the feature back up.
const REFUSAL_COOLDOWN_MS = 10 * 60_000

export interface RpcCaller {
  call(method: string, params: unknown[]): Promise<RpcResponse>
}

/**
 * Forwards eth_call / eth_estimateGas with `blockOverrides: { time }` pinned
 * to the head clock, falling back to the plain 3-param shape when the node
 * refuses the arity. The refusal is remembered per method (in memory), but
 * only once the plain retry is accepted — a request the node rejects either
 * way was malformed by the caller, and must not switch the feature off.
 */
export class HeadTimeForwarder {
  private readonly refusedUntil = new Map<string, number>()

  constructor(
    private readonly up: RpcCaller,
    private readonly now: () => number = Date.now,
  ) {}

  async call(method: string, params: unknown[]): Promise<RpcResponse> {
    const nowMs = this.now()
    if ((this.refusedUntil.get(method) ?? 0) > nowMs) return this.up.call(method, params)

    const withTime = [...params, { time: toQuantity(headTime(undefined, nowMs)) }]
    const resp = await this.up.call(method, withTime)
    if (!resp.error || !isArityRejection(resp.error)) return resp

    const plain = await this.up.call(method, params)
    if (!plain.error || !isArityRejection(plain.error)) {
      this.refusedUntil.set(method, nowMs + REFUSAL_COOLDOWN_MS)
    }
    return plain
  }
}
