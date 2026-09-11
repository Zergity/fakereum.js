// Etherscan v2 /api proxy logic as PURE helpers. Ports the relevant pieces of
// proxy.go (HandleEtherscan + helpers): query rewriting, the topicI_J_opr
// transitive-closure completion, chainid forcing + apikey injection, fromBlock/
// toBlock 0x-hex normalization, and the getLogs sandbox merge. The Durable
// Object performs all I/O (the upstream fetch) and calls into these.
//
// All functions here are pure: no fetch, no storage, no global state.

import { isAddressSlot } from './impersonate/store'
import {
  bytesToHex,
  hexToBytes,
  strip0x,
  toBigInt,
  toQuantity,
  type Hex,
} from './lib/hex'
import type { StoredLog } from './types'

// --------------------------------------------------------------------------
// isGetLogs
// --------------------------------------------------------------------------

/** True for a module=logs&action=getLogs request (case-sensitive, matching Go). */
export function isGetLogs(params: URLSearchParams): boolean {
  return params.get('module') === 'logs' && params.get('action') === 'getLogs'
}

// --------------------------------------------------------------------------
// completeTopicOperators (ports completeGetLogsOperators, but in place)
// --------------------------------------------------------------------------

/**
 * Fill in any missing topicI_J_opr params so strict Etherscan-compatible
 * backends (notably BlockScout, which rejects with "Required query parameters
 * missing: topicI_J_opr") accept the request. The inferred value is "or" when
 * positions I and J are reachable through explicit OR edges (transitive
 * closure via union-find — matches real Etherscan's reading of chained
 * _opr=or), "and" otherwise.
 *
 * Mutates `params` in place. Safe to call regardless of how many topic
 * positions are set; a no-op when fewer than two are present.
 */
export function completeTopicOperators(params: URLSearchParams): void {
  const present: number[] = []
  for (let i = 0; i < 4; i++) {
    if (params.get(`topic${i}`)) present.push(i)
  }
  if (present.length < 2) return

  const find = orUnionFind(present, params)

  for (let i = 0; i < present.length; i++) {
    const a = present[i]!
    for (let j = i + 1; j < present.length; j++) {
      const b = present[j]!
      const key = `topic${a}_${b}_opr`
      if (params.get(key)) continue
      params.set(key, find(a) === find(b) ? 'or' : 'and')
    }
  }
}

/**
 * Partition the present topic positions (0..3) into OR-groups by the same
 * transitive closure completeTopicOperators uses: positions joined by any chain
 * of topicI_J_opr=or edges share a group; everything else is a singleton. The
 * sandbox log matcher reads these groups so its filtering honors Etherscan's
 * cross-position OR — without them it would AND every set position, turning a
 * 3-topic OR into an (almost always empty) intersection.
 *
 * Returns groups as ascending position lists, ordered by first position; empty
 * when no topic position is present. Mirrors logMatches' "OR within a group,
 * AND across groups" evaluation. Unlike completeTopicOperators this runs even
 * for a single present position (it yields one singleton group) so the matcher
 * has a complete description of which positions to test.
 */
export function topicOrGroups(params: URLSearchParams): number[][] {
  const present: number[] = []
  for (let i = 0; i < 4; i++) {
    if (params.get(`topic${i}`)) present.push(i)
  }
  if (present.length === 0) return []

  const find = orUnionFind(present, params)
  const byRoot = new Map<number, number[]>()
  for (const p of present) {
    const r = find(p)
    const g = byRoot.get(r)
    if (g) g.push(p)
    else byRoot.set(r, [p])
  }
  return [...byRoot.values()]
    .map((g) => g.slice().sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!)
}

/**
 * Union-find over the present topic positions, unioning any pair (a,b) whose
 * topicA_B_opr param is "or". Returns the path-compressing `find` accessor so
 * callers can either compare roots (completeTopicOperators) or bucket positions
 * by component (topicOrGroups). Pure; never mutates `params`.
 */
function orUnionFind(present: number[], params: URLSearchParams): (x: number) => number {
  const parent = new Map<number, number>()
  for (const p of present) parent.set(p, p)
  const find = (x: number): number => {
    const px = parent.get(x)!
    if (px === x) return x
    const root = find(px)
    parent.set(x, root)
    return root
  }
  for (let i = 0; i < present.length; i++) {
    const a = present[i]!
    for (let j = i + 1; j < present.length; j++) {
      const b = present[j]!
      if ((params.get(`topic${a}_${b}_opr`) ?? '').toLowerCase() === 'or') {
        parent.set(find(a), find(b))
      }
    }
  }
  return find
}

// --------------------------------------------------------------------------
// rewriteEtherscanParams
// --------------------------------------------------------------------------

export interface RewriteEtherscanOpts {
  /** Real upstream chain id; chainid is ALWAYS forced to this (decimal). */
  upstreamChainId: bigint
  /** API key to inject when the request carries none. */
  apiKey?: string
  /** Impersonator B -> impersonatee A address swap. */
  swap: (addr: Hex) => Hex
  /**
   * getLogs fromBlock/toBlock format the upstream expects: 'hex' (Etherscan
   * v2, default) or 'decimal' (Blockscout's Etherscan-compat endpoint).
   */
  blockFormat?: 'hex' | 'decimal'
  /**
   * Query param that names the chain: 'chainid' (Etherscan v2, default) or
   * 'chain_id' (Blockscout's multichain PRO gateway, api.blockscout.com/v2/api,
   * which answers "Unknown module" style errors without it). A single-chain
   * explorer ignores either.
   */
  chainParam?: 'chainid' | 'chain_id'
}

/**
 * Return a NEW URLSearchParams forwarded upstream:
 *  - the chain param (chainid, or chain_id for Blockscout's PRO gateway) forced
 *    to opts.upstreamChainId (decimal). The dapp parrots back fakereum's sandbox
 *    chain id, but upstream needs the real one to index logs.
 *  - apikey injected when absent (and opts.apiKey set).
 *  - For module=logs&action=getLogs: address= (incl. comma-separated) and
 *    topic0..topic3 rewritten B->A via opts.swap, and fromBlock/toBlock
 *    normalized to 0x-hex when bare decimals.
 *  - Other modules: plain passthrough (only chainid + apikey touched).
 *
 * The input is never mutated.
 */
export function rewriteEtherscanParams(
  params: URLSearchParams,
  opts: RewriteEtherscanOpts,
): URLSearchParams {
  const out = new URLSearchParams(params)
  const getLogs = isGetLogs(out)

  if (getLogs) {
    // address= (and comma-separated multi-address form) B->A.
    rewriteAddressParam(out, opts.swap)
    // topic0..topic3: address-padded 32-byte slots B->A.
    for (let i = 0; i < 4; i++) {
      const key = `topic${i}`
      const v = out.get(key)
      if (v == null) continue
      const [nv, changed] = rewriteTopicHex(v, opts.swap)
      if (changed) out.set(key, nv)
    }
    normalizeGetLogsBlocks(out, opts.blockFormat ?? 'hex')
  }

  // The chain is ALWAYS forced to the upstream chain id: the dapp parrots back
  // fakereum's sandbox id, which no explorer indexes.
  if (opts.upstreamChainId !== 0n) {
    out.set(opts.chainParam ?? 'chainid', opts.upstreamChainId.toString(10))
  }
  // Inject apikey only when the caller didn't already provide one.
  if (opts.apiKey && !out.get('apikey')) {
    out.set('apikey', opts.apiKey)
  }

  return out
}

/** B->A over the address= param (handles the comma-separated multi form). */
function rewriteAddressParam(params: URLSearchParams, swap: (addr: Hex) => Hex): void {
  const v = params.get('address')
  if (v == null) return
  const parts = v.split(',')
  let changed = false
  for (let j = 0; j < parts.length; j++) {
    const trimmed = parts[j]!.trim()
    if (!isHexAddress(trimmed)) continue
    const addr = ('0x' + strip0x(trimmed).toLowerCase()) as Hex
    const swapped = swap(addr)
    if (swapped.toLowerCase() === addr.toLowerCase()) continue
    parts[j] = swapped
    changed = true
  }
  if (changed) params.set('address', parts.join(','))
}

/**
 * Rewrite an address-padded 32-byte topic hex B->A. Mirrors proxy.go's
 * rewriteTopicHex (decode → require exactly 32 bytes → RewriteSlots), but
 * driven by the supplied address swap rather than the Impersonators slot
 * primitive (which isn't available to a pure helper). The slot-shape gate is
 * reproduced via isAddressSlot.
 */
function rewriteTopicHex(s: string, swap: (addr: Hex) => Hex): [string, boolean] {
  let b: Uint8Array
  try {
    b = hexToBytes(s)
  } catch {
    return [s, false]
  }
  // proxy.go requires hexutil.Decode to succeed AND the value to be 32 bytes.
  if (!isHexString(s) || b.length !== 32) return [s, false]
  if (!isAddressSlot(b)) return [s, false]
  const from = bytesToHex(b.subarray(12, 32)) as Hex
  const to = swap(from)
  if (to.toLowerCase() === from.toLowerCase()) return [s, false]
  const out = b.slice()
  out.set(hexToBytes(toAddress20(to)), 12)
  return [bytesToHex(out), true]
}

/**
 * Rewrite fromBlock/toBlock in place to the number format the upstream
 * explorer expects. Etherscan v2's getLogs silently returns "No records found"
 * for bare-decimal block numbers ('hex'); Blockscout's Etherscan-compat
 * endpoint rejects 0x-hex with "Invalid fromBlock format" ('decimal'). Named
 * tags (latest/pending/safe/finalized/earliest) and values already in the
 * target format are left untouched.
 */
function normalizeGetLogsBlocks(params: URLSearchParams, format: 'hex' | 'decimal'): void {
  for (const key of ['fromBlock', 'toBlock']) {
    const v = params.get(key)
    if (!v) continue
    const lower = v.toLowerCase()
    switch (lower) {
      case 'latest':
      case 'pending':
      case 'safe':
      case 'finalized':
      case 'earliest':
        continue
    }
    if (format === 'hex') {
      if (lower.startsWith('0x')) continue
      if (!isDecimal(v)) continue
      params.set(key, '0x' + BigInt(v).toString(16))
    } else {
      if (!lower.startsWith('0x')) continue
      if (!isHexString(v)) continue
      params.set(key, BigInt(v).toString(10))
    }
  }
}

// --------------------------------------------------------------------------
// toEtherscanLog (ports etherscanLogEntry)
// --------------------------------------------------------------------------

export interface ToEtherscanLogOpts {
  /** Block timestamp QUANTITY (from the sandbox tx entry); defaults to 0x0. */
  timeStamp?: Hex
  /** Gas used QUANTITY (from the sandbox tx entry); defaults to 0x0. */
  gasUsed?: Hex
}

/**
 * Render a sandbox StoredLog into an Etherscan getLogs record. Mirrors the
 * field set proxy.go's etherscanLogEntry emits: blockNumber/logIndex as minimal
 * 0x-hex quantities, gasPrice always "0x0", transactionIndex always "0x0",
 * timeStamp/gasUsed sourced from the owning sandbox tx (0x0 when unknown).
 */
export function toEtherscanLog(
  log: StoredLog,
  opts: ToEtherscanLogOpts = {},
): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: toQuantity(toBigInt(log.blockNumber)),
    blockHash: log.blockHash,
    timeStamp: opts.timeStamp ?? '0x0',
    gasPrice: '0x0',
    gasUsed: opts.gasUsed ?? '0x0',
    logIndex: toQuantity(toBigInt(log.logIndex)),
    transactionHash: log.transactionHash,
    transactionIndex: '0x0',
  }
}

// --------------------------------------------------------------------------
// mergeGetLogsResult (ports the tail of handleEtherscanGetLogs)
// --------------------------------------------------------------------------

export interface GetLogsBlockFilter {
  fromBlock: bigint | null
  toBlock: bigint | null
}

interface EtherscanEnvelope {
  status?: unknown
  message?: unknown
  result?: unknown
}

/**
 * Merge upstream getLogs JSON with sandbox-derived records.
 *
 *  - If upstream is NOTOK/error (result is not an array — i.e. a text message)
 *    and the sandbox has nothing of its own, return the upstream JSON verbatim
 *    so the caller sees the real failure.
 *  - If upstream failed but the sandbox DID match logs, answer with those. A
 *    fork-only log exists in no explorer index anywhere, so discarding it
 *    because the upstream half of the range is unavailable loses the only copy
 *    — and clients read a NOTOK as "no history" (an account's whole position
 *    history vanishing on a dapp, observed on Robinhood Chain 2026-09, whose
 *    explorer answers every non-browser caller with a Cloudflare challenge).
 *    The envelope says so: `message` is OK-prefixed so Etherscan clients accept
 *    it, and carries the upstream failure so partial coverage stays visible.
 *  - Otherwise client-side filter upstream entries to [fromBlock, toBlock]
 *    (defensive: Etherscan v2 sometimes returns out-of-range blocks), append
 *    the sandbox records, stable-sort by (blockNumber, logIndex) only when the
 *    sandbox actually contributed, and return the OK envelope. Empty result
 *    yields the "No records found" status=0 shape, matching proxy.go.
 */
export function mergeGetLogsResult(
  upstreamJson: unknown,
  sandboxRecords: Array<Record<string, unknown>>,
  filter: GetLogsBlockFilter,
): unknown {
  const env = (upstreamJson ?? {}) as EtherscanEnvelope
  const upstreamResult = env.result

  // NOTOK / error: upstream "result" is a text string (or otherwise not an
  // array). Pass the payload through verbatim — unless the sandbox can still
  // answer, in which case its own logs beat an error that would read as "none".
  if (!Array.isArray(upstreamResult)) {
    if (sandboxRecords.length === 0) return upstreamJson
    return {
      status: '1',
      message: 'OK (sandbox only, upstream unavailable: ' + describeFailure(env) + ')',
      result: sortByBlockAndIndex(sandboxRecords),
    }
  }

  let entries = upstreamResult as Array<Record<string, unknown>>

  // Defensive client-side block-range filter on upstream entries.
  if (filter.fromBlock !== null || filter.toBlock !== null) {
    entries = filterEntriesByBlock(entries, filter.fromBlock, filter.toBlock)
  }

  const sandboxStart = entries.length
  entries = entries.concat(sandboxRecords)

  // Re-sort only when sandbox actually contributed; otherwise upstream's order
  // stands (stable sort preserves the relative order of equal keys).
  if (sandboxStart > 0 && entries.length > sandboxStart) {
    entries = sortByBlockAndIndex(entries)
  }

  if (entries.length === 0) {
    return { status: '0', message: 'No records found', result: [] }
  }
  return { status: '1', message: 'OK', result: entries }
}

/** Chronological (blockNumber, logIndex) order — the order clients replay in. */
function sortByBlockAndIndex(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return stableSort(entries, (a, b) => {
    const ba = hexUint(a['blockNumber'])
    const bb = hexUint(b['blockNumber'])
    if (ba !== bb) return ba < bb ? -1 : 1
    const la = hexUint(a['logIndex'])
    const lb = hexUint(b['logIndex'])
    if (la === lb) return 0
    return la < lb ? -1 : 1
  })
}

/** One-line reason from a failed upstream envelope, for the partial-answer message. */
function describeFailure(env: EtherscanEnvelope): string {
  const result = typeof env.result === 'string' ? env.result.trim() : ''
  const message = typeof env.message === 'string' ? env.message.trim() : ''
  const text = result || message || 'no result'
  return text.length > 200 ? text.slice(0, 197) + '...' : text
}

/**
 * Drop entries whose blockNumber falls outside [fromBlock, toBlock]. blockNumber
 * is parsed as 0x-hex (base 16); unparseable values are kept rather than
 * silently dropped. Either bound may be null (unbounded). Mirrors
 * filterEntriesByBlock.
 */
function filterEntriesByBlock(
  entries: Array<Record<string, unknown>>,
  fromBlock: bigint | null,
  toBlock: bigint | null,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const e of entries) {
    const bnStr = typeof e['blockNumber'] === 'string' ? (e['blockNumber'] as string) : ''
    const bn = parseHexBig(bnStr)
    if (bn === null) {
      // Unparseable blockNumber — keep it rather than drop silently.
      out.push(e)
      continue
    }
    if (fromBlock !== null && bn < fromBlock) continue
    if (toBlock !== null && bn > toBlock) continue
    out.push(e)
  }
  return out
}

// --------------------------------------------------------------------------
// local helpers
// --------------------------------------------------------------------------

/** Strict 0x-prefixed hex string (hexutil.Decode accepts only this form). */
function isHexString(s: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(s)
}

/** 20-byte 0x-hex address, case-insensitive (mirrors common.IsHexAddress). */
function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

/** Bare base-10 integer (matches Go big.Int.SetString(_, 10)). */
function isDecimal(s: string): boolean {
  return /^[0-9]+$/.test(s)
}

/** Lowercase 20-byte 0x address from any (already-validated) address hex. */
function toAddress20(s: string): Hex {
  return ('0x' + strip0x(s).toLowerCase().padStart(40, '0').slice(-40)) as Hex
}

/**
 * Parse a "0x..." (or bare) hex string to bigint, base 16, returning null on
 * malformed input. Mirrors filterEntriesByBlock's big.Int.SetString(_, 16)
 * over the 0x-stripped string.
 */
function parseHexBig(s: string): bigint | null {
  const h = strip0x(s)
  if (h === '' || !/^[0-9a-fA-F]+$/.test(h)) return null
  return BigInt('0x' + h)
}

/**
 * Parse a "0x..." hex string into a number for stable-ordering merged results,
 * bottoming out at 0 on anything malformed (mirrors hexUint, which clamps to
 * uint64). Sort keys only, so the lossy Number coercion is acceptable; we keep
 * bigint to stay exact for very large block numbers.
 */
function hexUint(v: unknown): bigint {
  if (typeof v !== 'string' || v.length < 3) return 0n
  const h = strip0x(v)
  if (!/^[0-9a-fA-F]+$/.test(h)) return 0n
  return BigInt('0x' + h)
}

/** Stable sort (Array.prototype.sort is spec-stable, but be explicit). */
function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => [v, i] as const)
    .sort((x, y) => {
      const c = cmp(x[0], y[0])
      return c !== 0 ? c : x[1] - y[1]
    })
    .map(([v]) => v)
}
