// ABI decoding for the explorer — a faithful port of tx_decode.go.
//
// Go leans on go-ethereum's accounts/abi (MethodById / EventByID / ErrorByID +
// reflection-based value formatting). Here we use viem's decoders, but we still
// do our own selector/topic matching against the passed-in ABI so we can
// reproduce the exact parameter order, names, indexed flags, and the
// human-readable value rendering that formatABIValue produces in Go.
//
// Pure module: no fetch / no storage. ABIs are always supplied by the caller —
// nothing here fetches them. viem decoders throw on a mismatch, so every call
// into them is wrapped and degrades to `null`.

import {
  decodeAbiParameters,
  decodeErrorResult,
  getAddress,
  type AbiParameter,
} from 'viem'
import type { DecodedArg, DecodedCall, DecodedLogEntry } from '../types'
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  strip0x,
  type Hex,
} from '../lib/hex'

// --------------------------------------------------------------------------
// Minimal structural views of the ABI entries we care about. We accept
// `unknown[]` at the boundary (ABIs come from untrusted upstream JSON) and
// narrow defensively, so we never assume viem's exported `Abi` type shape.
// --------------------------------------------------------------------------
interface AbiParam {
  name?: string
  type: string
  components?: AbiParam[]
  indexed?: boolean
}
interface AbiFunctionLike {
  type: 'function'
  name: string
  inputs?: AbiParam[]
}
interface AbiEventLike {
  type: 'event'
  name: string
  inputs?: AbiParam[]
}
interface AbiErrorLike {
  type: 'error'
  name: string
  inputs?: AbiParam[]
}

// 4-byte selectors of Solidity's built-in revert types.
const SELECTOR_ERROR = '08c379a0' // Error(string)
const SELECTOR_PANIC = '4e487b71' // Panic(uint256)

// --------------------------------------------------------------------------
// Selector / signature helpers. We compute canonical signatures ("transfer
// (address,uint256)" etc.) and keccak them ourselves so a single code path
// covers function selectors (first 4 bytes) and event topic0 (full 32 bytes),
// without depending on viem helpers outside the allowed import set.
// --------------------------------------------------------------------------

/** Canonical type string for a parameter (tuples expand to "(t1,t2)[]"). */
function canonicalType(p: AbiParam): string {
  const base = p.type
  if (base.startsWith('tuple')) {
    const inner = (p.components ?? []).map(canonicalType).join(',')
    // tuple, tuple[], tuple[2] -> (..)<suffix>
    const suffix = base.slice('tuple'.length)
    return `(${inner})${suffix}`
  }
  return base
}

/** Canonical signature, e.g. "transfer(address,uint256)". */
function signatureOf(name: string, inputs: AbiParam[] | undefined): string {
  const parts = (inputs ?? []).map(canonicalType)
  return `${name}(${parts.join(',')})`
}

/** keccak256 of a UTF-8 signature, as lowercase 0x-hex (no prefix stripping). */
function signatureHash(sig: string): Hex {
  return bytesToHex(keccak256(new TextEncoder().encode(sig)))
}

/** 4-byte selector (lowercase, no 0x) for a function/error signature. */
function selector4(name: string, inputs: AbiParam[] | undefined): string {
  return strip0x(signatureHash(signatureOf(name, inputs))).slice(0, 8)
}

// --------------------------------------------------------------------------
// ABI narrowing.
// --------------------------------------------------------------------------
function asEntries(abi: unknown[] | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(abi)) return []
  return abi.filter(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
  )
}

function isFunction(e: Record<string, unknown>): e is AbiFunctionLike & Record<string, unknown> {
  return e['type'] === 'function' && typeof e['name'] === 'string'
}
function isEvent(e: Record<string, unknown>): e is AbiEventLike & Record<string, unknown> {
  return e['type'] === 'event' && typeof e['name'] === 'string'
}
function isError(e: Record<string, unknown>): e is AbiErrorLike & Record<string, unknown> {
  return e['type'] === 'error' && typeof e['name'] === 'string'
}

function params(e: { inputs?: AbiParam[] }): AbiParam[] {
  return Array.isArray(e.inputs) ? e.inputs : []
}

// --------------------------------------------------------------------------
// Value formatting — mirrors formatABIValue (tx_decode.go).
//
//   address  -> EIP-55 checksum hex
//   hash/    -> lowercase 0x-hex (bytes32 indexed topic, etc.)
//   bytesN   -> 0x + lowercase hex
//   bool     -> "true" / "false"
//   int/uint -> decimal string (bigint)
//   string   -> as-is
//   array    -> "[a, b, c]"
//   tuple    -> "{Field=val, ...}"   (Go capitalizes struct field names)
//
// `value` is whatever viem's decoder returned for this position; `type` is the
// canonical ABI type so we can tell address/bytesN/tuple apart from raw hex.
// --------------------------------------------------------------------------
function formatValue(value: unknown, p: AbiParam): string {
  if (value === undefined || value === null) return ''

  const base = p.type

  // Array types: "T[]" / "T[N]". Strip the trailing [...] to get the element
  // type and render each element, matching Go's "[a, b, c]".
  const arrMatch = /^(.*)\[(\d*)\]$/.exec(base)
  if (arrMatch && Array.isArray(value)) {
    const elemType = arrMatch[1]!
    const elem: AbiParam = { type: elemType, name: p.name, components: p.components }
    return '[' + value.map((v) => formatValue(v, elem)).join(', ') + ']'
  }

  // Tuple / struct: viem returns an object keyed by component name (or, for
  // unnamed components, an array). Go renders "{Field=val, ...}" with the ABI
  // field names. We use the component name and fall back to positional access.
  if (base.startsWith('tuple') && !arrMatch) {
    const comps = p.components ?? []
    const parts: string[] = []
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i]!
      let v: unknown
      if (Array.isArray(value)) {
        v = value[i]
      } else if (typeof value === 'object' && value !== null && c.name) {
        v = (value as Record<string, unknown>)[c.name]
      }
      const fieldName = c.name && c.name.length > 0 ? capitalize(c.name) : `Field${i}`
      parts.push(`${fieldName}=${formatValue(v, c)}`)
    }
    return '{' + parts.join(', ') + '}'
  }

  // address -> checksum.
  if (base === 'address' && typeof value === 'string') {
    try {
      return getAddress(value)
    } catch {
      return value
    }
  }

  // bool.
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  // int/uint -> decimal. viem returns bigint for numeric types.
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return value.toString()

  // bytes / bytesN / fixed-bytes indexed topics -> 0x lowercase hex.
  // viem already returns these as 0x-prefixed lowercase hex strings.
  if ((base === 'bytes' || /^bytes\d+$/.test(base)) && typeof value === 'string') {
    return value.toLowerCase()
  }

  // string -> verbatim.
  if (typeof value === 'string') return value

  // Fallback (should be rare): stringify.
  return String(value)
}

// toCamelCase mirrors go-ethereum's abi.ToCamelCase: split on "_" and
// upper-case the first letter of each word ("my_field" -> "MyField"). This is
// the field name reflection sees on the generated struct in formatABIValue.
function capitalize(s: string): string {
  if (s.length === 0) return s
  return s
    .split('_')
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
    .join('')
}

// --------------------------------------------------------------------------
// decodeCalldata — port of decodeCallData.
// Match by 4-byte selector against the ABI's functions, then decode args.
// Returns null on length<4, unknown selector, or unpack failure.
// --------------------------------------------------------------------------
export function decodeCalldata(abi: unknown[], data: Hex): DecodedCall | null {
  const bytes = hexToBytes(data)
  if (bytes.length < 4) return null
  const sel = strip0x(bytesToHex(bytes.slice(0, 4))).toLowerCase()

  for (const e of asEntries(abi)) {
    if (!isFunction(e)) continue
    const inputs = params(e)
    if (selector4(e.name, inputs) !== sel) continue

    // Decode the argument tail (everything after the 4-byte selector).
    let values: readonly unknown[]
    try {
      values = decodeAbiParameters(
        inputs as unknown as readonly AbiParameter[],
        bytesToHex(bytes.slice(4)),
      )
    } catch {
      return null
    }

    const args: DecodedArg[] = inputs.map((p, i) => ({
      name: p.name ?? '',
      type: canonicalType(p),
      value: formatValue(values[i], p),
    }))
    return { method: e.name, args }
  }
  return null
}

// --------------------------------------------------------------------------
// decodeEventLog — port of decodeLog.
// Match by topic0, interleave indexed (topics[1:]) and non-indexed (data)
// values back into declaration order, and mark indexed args.
// --------------------------------------------------------------------------
export function decodeEventLog(
  abi: unknown[],
  topics: Hex[],
  data: Hex,
): DecodedLogEntry | null {
  if (topics.length === 0) return null
  const topic0 = topics[0]!.toLowerCase()

  for (const e of asEntries(abi)) {
    if (!isEvent(e)) continue
    const inputs = params(e)
    if (signatureHash(signatureOf(e.name, inputs)).toLowerCase() !== topic0) continue

    // Non-indexed args are ABI-decoded from the log data, in their relative
    // order. Decode lazily and tolerate failure (Go leaves them empty).
    const nonIndexed = inputs.filter((p) => !p.indexed)
    let nonIndexedValues: readonly unknown[] = []
    const dataBytes = hexToBytes(data)
    if (nonIndexed.length > 0 && dataBytes.length > 0) {
      try {
        nonIndexedValues = decodeAbiParameters(
          nonIndexed as unknown as readonly AbiParameter[],
          data,
        )
      } catch {
        nonIndexedValues = []
      }
    }

    const args: DecodedArg[] = []
    let topicIdx = 1
    let nonIdx = 0
    for (const p of inputs) {
      let value: string
      if (p.indexed) {
        if (topicIdx < topics.length) {
          value = formatIndexedTopic(p, topics[topicIdx]!)
          topicIdx++
        } else {
          value = ''
        }
      } else {
        const v = nonIdx < nonIndexedValues.length ? nonIndexedValues[nonIdx] : undefined
        nonIdx++
        value = formatValue(v, p)
      }
      args.push({
        name: p.name ?? '',
        type: canonicalType(p),
        value,
        indexed: p.indexed === true,
      })
    }
    return { name: e.name, args }
  }
  return null
}

// --------------------------------------------------------------------------
// decodeIndexedTopic (tx_decode.go) — extract a value from a 32-byte topic.
// Simple types decode to a typed value; dynamic types (string/bytes/array/
// tuple) only have the keccak hash in the slot, so we surface the raw topic.
// --------------------------------------------------------------------------
function formatIndexedTopic(p: AbiParam, topic: Hex): string {
  const base = p.type
  const word = padTopic(topic) // 32-byte word, lowercase 0x-hex

  if (base === 'address') {
    // Address lives in the low 20 bytes of the slot.
    const b = hexToBytes(word)
    try {
      return getAddress(bytesToHex(b.slice(12)))
    } catch {
      return bytesToHex(b.slice(12))
    }
  }
  if (base === 'bool') {
    const b = hexToBytes(word)
    return b[31] !== 0 ? 'true' : 'false'
  }
  if (/^u?int\d*$/.test(base)) {
    // int/uint -> SetBytes(topic) as decimal. Go uses big.Int.SetBytes which is
    // unsigned; mirror that (signed ints aren't reconstructed in the Go code).
    return BigInt(word).toString()
  }
  if (/^bytes\d+$/.test(base)) {
    // Fixed-bytes is left-aligned; take the leading Size bytes.
    const size = Number(base.slice('bytes'.length))
    const b = hexToBytes(word)
    return bytesToHex(b.slice(0, size)).toLowerCase()
  }
  // bytes32 "hash"-like, dynamic types, tuples -> the raw 32-byte topic.
  return word.toLowerCase()
}

/** Left-pad a topic to a 32-byte lowercase 0x word. */
function padTopic(topic: Hex): Hex {
  const b = hexToBytes(topic)
  if (b.length === 32) return bytesToHex(b)
  const out = new Uint8Array(32)
  if (b.length > 32) out.set(b.slice(b.length - 32))
  else out.set(b, 32 - b.length)
  return bytesToHex(out)
}

// --------------------------------------------------------------------------
// decodeRevertReason — port of decodeRevert.
//   Error(string)  -> the require/revert message
//   Panic(uint256) -> "Panic(0x<code>): <reason>"
//   custom error   -> "Name(arg=val, ...)" when the ABI is supplied
// Returns null for empty/short data or an undecodable selector.
// --------------------------------------------------------------------------
export function decodeRevertReason(
  returnData: Hex,
  abi?: unknown[] | null,
): string | null {
  const bytes = hexToBytes(returnData)
  if (bytes.length < 4) return null
  const sel = strip0x(bytesToHex(bytes.slice(0, 4))).toLowerCase()

  // Error(string) — the standard require()/revert("...") message.
  if (sel === SELECTOR_ERROR) {
    try {
      const [reason] = decodeAbiParameters(
        [{ type: 'string' }] as readonly AbiParameter[],
        bytesToHex(bytes.slice(4)),
      )
      return typeof reason === 'string' ? reason : null
    } catch {
      return null
    }
  }

  // Panic(uint256) — assert(false), overflow, div-by-zero, ...
  if (sel === SELECTOR_PANIC) {
    if (bytes.length < 36) return null
    const code = BigInt(bytesToHex(bytes.slice(4, 36)))
    return `Panic(0x${code.toString(16)}): ${panicReason(code)}`
  }

  // Custom error declared on the target contract's ABI.
  if (abi) {
    for (const e of asEntries(abi)) {
      if (!isError(e)) continue
      const inputs = params(e)
      if (selector4(e.name, inputs) !== sel) continue
      return formatCustomError(e.name, inputs, returnData)
    }
  }
  return null
}

// formatCustomError renders a matched custom error as "Name(arg=val, ...)",
// mirroring formatCustomError in Go (lowercase argN fallback names).
function formatCustomError(
  name: string,
  inputs: AbiParam[],
  returnData: Hex,
): string {
  let result: { args?: readonly unknown[] }
  try {
    result = decodeErrorResult({
      abi: [{ type: 'error', name, inputs }] as never,
      data: returnData,
    }) as { args?: readonly unknown[] }
  } catch {
    return `${name}(…)` // selector matched but args couldn't be decoded
  }
  const vals = result.args ?? []
  const parts = inputs.map((p, i) => {
    const argName = p.name && p.name.length > 0 ? p.name : `arg${i}`
    return `${argName}=${formatValue(vals[i], p)}`
  })
  return `${name}(${parts.join(', ')})`
}

// panicReason maps a Solidity Panic code to its documented meaning.
function panicReason(code: bigint): string {
  switch (code) {
    case 0x00n:
      return 'generic compiler-inserted panic'
    case 0x01n:
      return 'assertion failed (assert(false))'
    case 0x11n:
      return 'arithmetic overflow or underflow'
    case 0x12n:
      return 'division or modulo by zero'
    case 0x21n:
      return 'conversion to a non-existent enum value'
    case 0x22n:
      return 'access to an incorrectly encoded storage byte array'
    case 0x31n:
      return 'pop() on an empty array'
    case 0x32n:
      return 'array index out of bounds'
    case 0x41n:
      return 'out of memory (oversized allocation)'
    case 0x51n:
      return 'call to a zero-initialized internal function'
    default:
      return 'unknown panic code'
  }
}
