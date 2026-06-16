// Hex / bytes / address primitives shared across the port.
//
// These mirror the small handful of go-ethereum helpers fakereum leans on
// (common.HexToAddress, common.HexToHash, hexutil.EncodeBig, EIP-55 checksum)
// without dragging in a heavy dependency. keccak comes from @noble/hashes,
// which is what @ethereumjs/* already use, so there's no extra bundle cost.

import { keccak_256 } from '@noble/hashes/sha3.js'

export type Hex = `0x${string}`

const HEX_RE = /^0x[0-9a-fA-F]*$/

export function isHex(s: unknown): s is Hex {
  return typeof s === 'string' && HEX_RE.test(s)
}

/** Strip an optional 0x prefix. */
export function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
}

export function bytesToHex(b: Uint8Array): Hex {
  let out = '0x'
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0')
  return out as Hex
}

export function hexToBytes(s: string): Uint8Array {
  let h = strip0x(s)
  if (h.length % 2 !== 0) h = '0' + h
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let len = 0
  for (const a of arrs) len += a.length
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

export function keccak256Hex(data: Uint8Array): Hex {
  return bytesToHex(keccak256(data))
}

// --- quantities (eth JSON-RPC "QUANTITY": minimal 0x-hex, no leading zeros) ---

/** Encode a bigint/number as a minimal 0x-hex quantity ("0x0" for zero). */
export function toQuantity(n: bigint | number): Hex {
  const v = typeof n === 'bigint' ? n : BigInt(n)
  if (v < 0n) throw new Error('negative quantity')
  return ('0x' + v.toString(16)) as Hex
}

/** Parse a 0x-hex (or decimal) string to bigint. Accepts "" / null as 0n. */
export function toBigInt(s: string | null | undefined): bigint {
  if (s == null || s === '') return 0n
  const t = s.trim()
  if (t.startsWith('0x') || t.startsWith('0X')) return BigInt(t)
  return BigInt(t)
}

// --- 32-byte words (storage keys / values / hashes) -------------------------

/** Left-pad bytes to a 32-byte word (go-ethereum common.Hash semantics). */
export function toHash32(s: string | Uint8Array): Uint8Array {
  const b = typeof s === 'string' ? hexToBytes(s) : s
  if (b.length === 32) return b
  const out = new Uint8Array(32)
  if (b.length > 32) {
    out.set(b.slice(b.length - 32))
  } else {
    out.set(b, 32 - b.length)
  }
  return out
}

export function toHash32Hex(s: string | Uint8Array): Hex {
  return bytesToHex(toHash32(s))
}

export const ZERO_HASH = '0x' + '00'.repeat(32) as Hex

// --- addresses --------------------------------------------------------------

/** Normalize to a lowercase 20-byte 0x address. Throws on bad length. */
export function toAddress(s: string): Hex {
  const b = hexToBytes(s)
  if (b.length !== 20) {
    // go-ethereum HexToAddress is lenient (left-pads / right-trims); mirror the
    // common left-pad-to-20 behavior so short hex still maps to an address.
    const a = new Uint8Array(20)
    if (b.length > 20) a.set(b.slice(b.length - 20))
    else a.set(b, 20 - b.length)
    return bytesToHex(a)
  }
  return bytesToHex(b)
}

/** EIP-55 checksummed address (mixed case). */
export function checksumAddress(addr: string): Hex {
  const lower = strip0x(toAddress(addr)).toLowerCase()
  const hash = bytesToHex(keccak256(new TextEncoder().encode(lower))).slice(2)
  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c
  }
  return out as Hex
}

/** Case-insensitive address equality. */
export function addrEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return strip0x(a).toLowerCase() === strip0x(b).toLowerCase()
}

/** Lowercase 0x key suitable for use as a map key. */
export function addrKey(a: string): string {
  return ('0x' + strip0x(a).toLowerCase()) as string
}
