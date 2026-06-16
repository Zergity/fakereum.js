// Two-way B<->A address NAT across the JSON-RPC request/response surfaces.
// Ports impersonate_proxy.go (rewriteImpersonatorRequest / Response) and the
// StoredLog mirror of impersonate.go ReverseLog.
//
// Requests are rewritten one-directionally B->A (Swap) so a dapp connected as
// the impersonator B reads the impersonatee A's balance/nonce/code/proof/logs
// and call results. Responses are relabeled A->B (SwapBack, the *unambiguous*
// inverse) so the dapp recognizes its own address in returned data.
//
// Addresses that appear as full 0x-20-byte JSON strings use swap/swapBack.
// Address-padded 32-byte slots inside calldata / return data / topics use the
// byte-level rewriters (rewriteCalldata / rewriteSlots / rewriteSlotsBack).

import type { RpcRequest } from '../rpc'
import type { StoredLog } from '../types'
import {
  bytesToHex,
  hexToBytes,
  isHex,
  toAddress,
  type Hex,
} from '../lib/hex'
import { Impersonators, isAddressSlot } from './store'

// --------------------------------------------------------------------------
// Small typed helpers around the parsed-JSON surfaces.
// --------------------------------------------------------------------------

/** A JSON object (string-keyed). */
type JsonObj = Record<string, unknown>

function isObj(v: unknown): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True when the string is a 20-byte 0x hex address. */
function isAddressString(s: string): boolean {
  if (!isHex(s)) return false
  // toAddress is lenient; require exactly 20 bytes (40 hex digits) so longer
  // hashes / calldata blobs aren't mistaken for addresses.
  return s.length === 42
}

/**
 * Swap a single JSON value B->A when it's an impersonator address. Returns the
 * new (checksummed) address string and true, else [value, false].
 */
function swapAddrValue(v: unknown, im: Impersonators): [unknown, boolean] {
  if (typeof v !== 'string' || !isAddressString(v)) return [v, false]
  const swapped = im.swap(toAddress(v))
  if (swapped.toLowerCase() === toAddress(v).toLowerCase()) return [v, false]
  return [swapped, true]
}

/**
 * SwapBack a single JSON value A->B (unambiguous). Returns the new
 * (checksummed) address string and true, else [value, false].
 */
function swapBackAddrValue(v: unknown, im: Impersonators): [unknown, boolean] {
  if (typeof v !== 'string' || !isAddressString(v)) return [v, false]
  const back = im.swapBack(toAddress(v))
  if (back.toLowerCase() === toAddress(v).toLowerCase()) return [v, false]
  return [back, true]
}

/** Decode a 0x-hex string to bytes, or null when it isn't valid hex. */
function decodeHex(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || !isHex(v)) return null
  return hexToBytes(v)
}

// --------------------------------------------------------------------------
// REQUEST: B -> A
// --------------------------------------------------------------------------

/**
 * Returns req unchanged, or a shallow clone with params rewritten B->A so a
 * dapp connected as impersonator B reads impersonatee A's view. No-op when
 * there are no impersonators. Mirrors rewriteImpersonatorRequest.
 *
 * Substitution sites:
 *   eth_getBalance / eth_getTransactionCount / eth_getCode / eth_getProof
 *     -> params[0] (the looked-up / proved address)
 *   eth_call / eth_estimateGas / eth_createAccessList
 *     -> params[0].from
 *     -> params[0].data / .input  (calldata: 4-byte selector + slot tail)
 *     -> params[2] (stateOverrides) map keys  [eth_call / eth_estimateGas only]
 *   eth_getLogs            -> params[0].address (string|array) + .topics
 *   eth_subscribe ("logs") -> params[1] (same filter shape)
 *
 * eth_getStorageAt is intentionally NOT rewritten; neither is `to`. Block
 * enumeration RPCs are left untouched.
 */
export function rewriteImpersonatorRequest(req: RpcRequest, im: Impersonators): RpcRequest {
  if (im.isEmpty()) return req
  switch (req.method) {
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_getCode':
    case 'eth_getProof':
      return rewriteAddressFirstParam(req, im)
    case 'eth_call':
    case 'eth_estimateGas':
    case 'eth_createAccessList':
      return rewriteCallArgs(req, im)
    case 'eth_getLogs':
      return rewriteLogsParams(req, im)
    case 'eth_subscribe':
      return rewriteSubscribeParams(req, im)
    default:
      return req
  }
}

/** Shallow clone of req with params replaced. */
function reqWithParams(req: RpcRequest, params: unknown[]): RpcRequest {
  return { ...req, params }
}

function rewriteAddressFirstParam(req: RpcRequest, im: Impersonators): RpcRequest {
  const parts = req.params
  if (!Array.isArray(parts) || parts.length === 0) return req
  const [nv, changed] = swapAddrValue(parts[0], im)
  if (!changed) return req
  const next = parts.slice()
  next[0] = nv
  return reqWithParams(req, next)
}

function rewriteCallArgs(req: RpcRequest, im: Impersonators): RpcRequest {
  const parts = req.params
  if (!Array.isArray(parts) || parts.length === 0) return req
  const [obj0, ch0] = rewriteCallObject(parts[0], im)
  let ch2 = false
  let obj2: unknown = parts.length >= 3 ? parts[2] : undefined
  if (parts.length >= 3 && parts[2] != null) {
    ;[obj2, ch2] = rewriteStateOverridesKeys(parts[2], im)
  }
  if (!ch0 && !ch2) return req
  const next = parts.slice()
  next[0] = obj0
  if (parts.length >= 3) next[2] = obj2
  return reqWithParams(req, next)
}

/** Rewrite a call args object's `from` (address) and `data`/`input` (calldata). */
function rewriteCallObject(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let obj: JsonObj | null = null
  const ensure = (): JsonObj => (obj ??= { ...raw })

  const [fromV, fromCh] = swapAddrValue(raw['from'], im)
  if (fromCh) ensure()['from'] = fromV

  for (const key of ['data', 'input'] as const) {
    const v = raw[key]
    if (v == null) continue
    const data = decodeHex(v)
    if (!data) continue
    const [rewritten, changed] = im.rewriteCalldata(data)
    if (!changed) continue
    ensure()[key] = bytesToHex(rewritten)
  }

  return obj ? [obj, true] : [raw, false]
}

/** Rewrite stateOverrides map keys B->A (values untouched). */
function rewriteStateOverridesKeys(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let changed = false
  const out: JsonObj = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isAddressString(k)) {
      const swapped = im.swap(toAddress(k))
      if (swapped.toLowerCase() !== toAddress(k).toLowerCase()) {
        out[swapped] = v
        changed = true
        continue
      }
    }
    out[k] = v
  }
  return changed ? [out, true] : [raw, false]
}

function rewriteLogsParams(req: RpcRequest, im: Impersonators): RpcRequest {
  const parts = req.params
  if (!Array.isArray(parts) || parts.length === 0) return req
  const [nv, changed] = rewriteLogsFilter(parts[0], im)
  if (!changed) return req
  const next = parts.slice()
  next[0] = nv
  return reqWithParams(req, next)
}

/** eth_subscribe("logs"): the filter is the *second* positional param. */
function rewriteSubscribeParams(req: RpcRequest, im: Impersonators): RpcRequest {
  const parts = req.params
  if (!Array.isArray(parts) || parts.length < 2) return req
  if (parts[0] !== 'logs') return req
  const [nv, changed] = rewriteLogsFilter(parts[1], im)
  if (!changed) return req
  const next = parts.slice()
  next[1] = nv
  return reqWithParams(req, next)
}

/** Rewrite a logs filter object's `address` (string|array) and `topics`. */
function rewriteLogsFilter(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let obj: JsonObj | null = null
  const ensure = (): JsonObj => (obj ??= { ...raw })

  if ('address' in raw) {
    const [nv, ch] = rewriteAddrOrArray(raw['address'], im)
    if (ch) ensure()['address'] = nv
  }
  if ('topics' in raw) {
    const [nv, ch] = rewriteRequestTopics(raw['topics'], im)
    if (ch) ensure()['topics'] = nv
  }

  return obj ? [obj, true] : [raw, false]
}

/** address filter: a single address string OR an array of address strings. */
function rewriteAddrOrArray(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (typeof raw === 'string') return swapAddrValue(raw, im)
  if (Array.isArray(raw)) {
    let changed = false
    const out = raw.map((a) => {
      const [nv, ch] = swapAddrValue(a, im)
      if (ch) changed = true
      return nv
    })
    return changed ? [out, true] : [raw, false]
  }
  return [raw, false]
}

/**
 * Request-side topics: an array whose entries are (string | null | array of
 * strings). Each leaf is a 32-byte slot that may be an address-padded-to-32.
 */
function rewriteRequestTopics(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!Array.isArray(raw)) return [raw, false]
  let changed = false
  const out = raw.map((entry) => {
    if (entry == null) return entry
    if (typeof entry === 'string') {
      const [nv, ch] = rewriteTopicHex(entry, (d) => im.rewriteSlots(d))
      if (ch) changed = true
      return nv
    }
    if (Array.isArray(entry)) {
      let entryChanged = false
      const arr = entry.map((t) => {
        const [nv, ch] = rewriteTopicHex(t, (d) => im.rewriteSlots(d))
        if (ch) entryChanged = true
        return nv
      })
      if (entryChanged) {
        changed = true
        return arr
      }
      return entry
    }
    return entry
  })
  return changed ? [out, true] : [raw, false]
}

/**
 * Rewrite a single 32-byte topic hex string via the supplied slot rewriter
 * (rewriteSlots for B->A, rewriteSlotsBack for A->B). Non-32-byte or non-hex
 * values are left as-is.
 */
function rewriteTopicHex(
  v: unknown,
  rewrite: (d: Uint8Array) => [Uint8Array, boolean],
): [unknown, boolean] {
  const b = decodeHex(v)
  if (!b || b.length !== 32) return [v, false]
  const [out, changed] = rewrite(b)
  if (!changed) return [v, false]
  return [bytesToHex(out), true]
}

// --------------------------------------------------------------------------
// RESPONSE: A -> B (unambiguous inverse only)
// --------------------------------------------------------------------------

/**
 * Relabel the impersonatee A back to its unique impersonator B in the address-
 * bearing fields of a read response. No-op when there are no impersonators or
 * when result is null/undefined. Mirrors rewriteImpersonatorResponse.
 *
 * Surfaces:
 *   eth_call                  -> return data (rewriteSlotsBack on the hex bytes)
 *   eth_getLogs               -> array of log objects (address/topics/data)
 *   eth_getTransactionByHash  -> object: from / to
 *   eth_getTransactionReceipt -> object: from / to / contractAddress + logs[]
 *   eth_getProof              -> object: address
 *
 * Returns the rewritten result (or the original when nothing maps).
 */
export function rewriteImpersonatorResponseResult(
  method: string,
  result: unknown,
  im: Impersonators,
): unknown {
  if (im.isEmpty() || result == null) return result
  switch (method) {
    case 'eth_getLogs': {
      const [nv] = reverseLogArray(result, im)
      return nv
    }
    case 'eth_call': {
      const [nv] = reverseHexSlots(result, im)
      return nv
    }
    case 'eth_getTransactionByHash': {
      const [nv] = reverseObjectAddrFields(result, im, ['from', 'to'])
      return nv
    }
    case 'eth_getTransactionReceipt': {
      const [nv] = reverseReceiptObject(result, im)
      return nv
    }
    case 'eth_getProof': {
      const [nv] = reverseObjectAddrFields(result, im, ['address'])
      return nv
    }
    default:
      return result
  }
}

/** A->B over an eth_call/log data hex string (address-shaped 32-byte slots). */
function reverseHexSlots(raw: unknown, im: Impersonators): [unknown, boolean] {
  const data = decodeHex(raw)
  if (!data) return [raw, false]
  const [out, changed] = im.rewriteSlotsBack(data)
  if (!changed) return [raw, false]
  return [bytesToHex(out), true]
}

/**
 * Response-side topics: an array of single 32-byte hash strings (unlike a
 * filter, entries are never arrays/null). Each may be an address-padded slot.
 */
function reverseResponseTopics(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!Array.isArray(raw)) return [raw, false]
  let changed = false
  const out = raw.map((e) => {
    const [nv, ch] = rewriteTopicHex(e, (d) => im.rewriteSlotsBack(d))
    if (ch) changed = true
    return nv
  })
  return changed ? [out, true] : [raw, false]
}

/** A->B in a single log object's address / topics / data. */
function reverseLogObject(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let obj: JsonObj | null = null
  const ensure = (): JsonObj => (obj ??= { ...raw })

  if ('address' in raw) {
    const [nv, ch] = swapBackAddrValue(raw['address'], im)
    if (ch) ensure()['address'] = nv
  }
  if ('topics' in raw) {
    const [nv, ch] = reverseResponseTopics(raw['topics'], im)
    if (ch) ensure()['topics'] = nv
  }
  if ('data' in raw) {
    const [nv, ch] = reverseHexSlots(raw['data'], im)
    if (ch) ensure()['data'] = nv
  }

  return obj ? [obj, true] : [raw, false]
}

/** A->B across every log in an array (eth_getLogs result, receipt logs). */
function reverseLogArray(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!Array.isArray(raw)) return [raw, false]
  let changed = false
  const out = raw.map((e) => {
    const [nv, ch] = reverseLogObject(e, im)
    if (ch) changed = true
    return nv
  })
  return changed ? [out, true] : [raw, false]
}

/** A->B for the named top-level address fields of an object. */
function reverseObjectAddrFields(
  raw: unknown,
  im: Impersonators,
  keys: string[],
): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let obj: JsonObj | null = null
  const ensure = (): JsonObj => (obj ??= { ...raw })
  for (const k of keys) {
    if (!(k in raw)) continue
    const [nv, ch] = swapBackAddrValue(raw[k], im)
    if (ch) ensure()[k] = nv
  }
  return obj ? [obj, true] : [raw, false]
}

/** A->B in a receipt's from / to / contractAddress plus embedded logs[]. */
function reverseReceiptObject(raw: unknown, im: Impersonators): [unknown, boolean] {
  if (!isObj(raw)) return [raw, false]
  let obj: JsonObj | null = null
  const ensure = (): JsonObj => (obj ??= { ...raw })

  for (const k of ['from', 'to', 'contractAddress']) {
    if (!(k in raw)) continue
    const [nv, ch] = swapBackAddrValue(raw[k], im)
    if (ch) ensure()[k] = nv
  }
  if ('logs' in raw) {
    const [nv, ch] = reverseLogArray(raw['logs'], im)
    if (ch) ensure()['logs'] = nv
  }

  return obj ? [obj, true] : [raw, false]
}

// --------------------------------------------------------------------------
// StoredLog reverse (A -> B) — the hex-field mirror of impersonate.go ReverseLog.
// --------------------------------------------------------------------------

/**
 * Relabel the impersonatee A back to its unique impersonator B in a StoredLog:
 * the emitting address, any address-shaped indexed topic, and address-shaped
 * data slots. Returns the same object when nothing changed. No-op when there
 * are no impersonators. Mirrors Impersonators.ReverseLog.
 */
export function reverseLog(log: StoredLog, im: Impersonators): StoredLog {
  if (im.isEmpty()) return log
  let changed = false

  let address: Hex = log.address
  if (isAddressString(log.address)) {
    const b = im.swapBack(toAddress(log.address))
    if (b.toLowerCase() !== toAddress(log.address).toLowerCase()) {
      address = b
      changed = true
    }
  }

  let topicsChanged = false
  const topics: Hex[] = log.topics.map((t) => {
    const b = decodeHex(t)
    if (!b || b.length !== 32 || !isAddressSlot(b)) return t
    const [out, ch] = im.rewriteSlotsBack(b)
    if (!ch) return t
    topicsChanged = true
    return bytesToHex(out)
  })
  const newTopics = topicsChanged ? topics : log.topics
  if (topicsChanged) changed = true

  let data: Hex = log.data
  const dataBytes = decodeHex(log.data)
  if (dataBytes) {
    const [out, ch] = im.rewriteSlotsBack(dataBytes)
    if (ch) {
      data = bytesToHex(out)
      changed = true
    }
  }

  if (!changed) return log
  return { ...log, address, topics: newTopics, data }
}
