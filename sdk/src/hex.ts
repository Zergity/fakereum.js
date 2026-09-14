// Minimal hex / keccak helpers. Kept dependency-light: keccak256 comes from
// @noble/hashes, everything else is a few lines.

import { keccak_256 } from '@noble/hashes/sha3.js'

export type Hex = `0x${string}`

export function isHex(s: unknown): s is Hex {
  return typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s)
}

export function hexToBytes(s: string): Uint8Array {
  let h = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
  if (h.length % 2) h = '0' + h
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): Hex {
  let s = '0x'
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s as Hex
}

export function keccak256(data: Uint8Array): Hex {
  return bytesToHex(keccak_256(data))
}

/** Accepts a bigint, a JS number, a 0x-hex quantity or a decimal string. */
export function toBigInt(v: bigint | number | string | undefined | null, fallback = 0n): bigint {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(v)
  return BigInt(v) // BigInt('0x..') and BigInt('123') both work
}

export function toQuantity(n: bigint | number): Hex {
  return ('0x' + BigInt(n).toString(16)) as Hex
}

/** EIP-55 checksummed address. */
export function checksumAddress(addr: string): Hex {
  const lower = (addr.startsWith('0x') ? addr.slice(2) : addr).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not a 20-byte address: ${addr}`)
  const hash = keccak256(new TextEncoder().encode(lower)).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c
  }
  return out as Hex
}
