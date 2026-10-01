// Byte / hex / hash helpers for the Bitcoin sandbox. Bitcoin hex is bare (no
// 0x prefix), unlike src/lib/hex.ts, so these are kept separate on purpose.

import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function reversed(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b).reverse()
}

export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b))
export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b))
export { sha256 }

/** BIP340/341 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export function taggedHash(tag: string, ...msg: Uint8Array[]): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag))
  return sha256(concat(t, t, ...msg))
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true)
  return b
}

/** Bitcoin CompactSize. */
export function varint(n: number | bigint): Uint8Array {
  const v = BigInt(n)
  if (v < 0xfdn) return Uint8Array.of(Number(v))
  if (v <= 0xffffn) {
    const b = new Uint8Array(3)
    b[0] = 0xfd
    new DataView(b.buffer).setUint16(1, Number(v), true)
    return b
  }
  if (v <= 0xffffffffn) {
    const b = new Uint8Array(5)
    b[0] = 0xfe
    new DataView(b.buffer).setUint32(1, Number(v), true)
    return b
  }
  const b = new Uint8Array(9)
  b[0] = 0xff
  new DataView(b.buffer).setBigUint64(1, v, true)
  return b
}

export const varbytes = (b: Uint8Array): Uint8Array => concat(varint(b.length), b)

/** Sequential little-endian reader; every overrun throws instead of wrapping. */
export class Reader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos
  }

  bytes(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) throw new Error('truncated data')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  u8(): number {
    return this.bytes(1)[0]!
  }

  u32(): number {
    const b = this.bytes(4)
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
  }

  u64(): bigint {
    const b = this.bytes(8)
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true)
  }

  varint(): number {
    const first = this.u8()
    let v: bigint
    if (first < 0xfd) v = BigInt(first)
    else if (first === 0xfd) {
      const b = this.bytes(2)
      v = BigInt(new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true))
    } else if (first === 0xfe) v = BigInt(this.u32())
    else v = this.u64()
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint too large')
    return Number(v)
  }

  varbytes(): Uint8Array {
    return this.bytes(this.varint())
  }
}
