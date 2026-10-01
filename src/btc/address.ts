// Addresses <-> scriptPubKeys: base58check (P2PKH / P2SH) and bech32 / bech32m
// (segwit v0 / v1+). Mainnet and the shared testnet/signet/regtest prefixes.

import { concat, equalBytes, sha256d } from './bytes'

export type NetworkName = 'mainnet' | 'testnet' | 'signet' | 'regtest'

export interface Network {
  name: NetworkName
  /** Name Bitcoin Core reports from getblockchaininfo. */
  coreChain: 'main' | 'test' | 'signet' | 'regtest'
  hrp: string
  p2pkh: number
  p2sh: number
}

export const NETWORKS: Record<NetworkName, Network> = {
  mainnet: { name: 'mainnet', coreChain: 'main', hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  testnet: { name: 'testnet', coreChain: 'test', hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  signet: { name: 'signet', coreChain: 'signet', hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  regtest: { name: 'regtest', coreChain: 'regtest', hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4 },
}

// --- base58check -----------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(b: Uint8Array): string {
  let zeros = 0
  while (zeros < b.length && b[zeros] === 0) zeros++
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s
    n /= 58n
  }
  return '1'.repeat(zeros) + s
}

function base58Decode(s: string): Uint8Array | null {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) return null
    n = n * 58n + BigInt(i)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes])
}

function base58CheckEncode(version: number, payload: Uint8Array): string {
  const body = concat(Uint8Array.of(version), payload)
  return base58Encode(concat(body, sha256d(body).subarray(0, 4)))
}

function base58CheckDecode(s: string): { version: number; payload: Uint8Array } | null {
  const raw = base58Decode(s)
  if (!raw || raw.length < 5) return null
  const body = raw.subarray(0, raw.length - 4)
  if (!equalBytes(raw.subarray(raw.length - 4), sha256d(body).subarray(0, 4))) return null
  return { version: body[0]!, payload: body.subarray(1) }
}

// --- bech32 / bech32m ------------------------------------------------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const maxv = (1 << to) - 1
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!
    if (v < 0 || v >> from !== 0) return null
    acc = (acc << from) | v
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
    acc &= (1 << (bits + from)) - 1
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null
  }
  return out
}

function segwitEncode(hrp: string, version: number, program: Uint8Array): string {
  const data = [version, ...convertBits(program, 8, 5, true)!]
  const k = version === 0 ? BECH32_CONST : BECH32M_CONST
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ k
  const checksum = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31)
  return hrp + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('')
}

function segwitDecode(addr: string, hrp: string): { version: number; program: Uint8Array } | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null
  const a = addr.toLowerCase()
  const sep = a.lastIndexOf('1')
  if (sep < 1 || sep + 7 > a.length || a.length > 90) return null
  if (a.slice(0, sep) !== hrp) return null
  const data: number[] = []
  for (const c of a.slice(sep + 1)) {
    const i = CHARSET.indexOf(c)
    if (i < 0) return null
    data.push(i)
  }
  const version = data[0]!
  if (version > 16) return null
  const pm = polymod([...hrpExpand(hrp), ...data])
  if (pm !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) return null
  const program = convertBits(data.slice(1, data.length - 6), 5, 8, false)
  if (!program || program.length < 2 || program.length > 40) return null
  if (version === 0 && program.length !== 20 && program.length !== 32) return null
  return { version, program: Uint8Array.from(program) }
}

// --- scripts ---------------------------------------------------------------

export type ScriptType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'op_return' | 'unknown'

export interface ScriptInfo {
  type: ScriptType
  /** Hash / witness program the script commits to (not set for op_return / unknown). */
  program?: Uint8Array
}

export function classifyScript(s: Uint8Array): ScriptInfo {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) {
    return { type: 'p2pkh', program: s.subarray(3, 23) }
  }
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) {
    return { type: 'p2sh', program: s.subarray(2, 22) }
  }
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return { type: 'p2wpkh', program: s.subarray(2) }
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return { type: 'p2wsh', program: s.subarray(2) }
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return { type: 'p2tr', program: s.subarray(2) }
  if (s.length > 0 && s[0] === 0x6a) return { type: 'op_return' }
  return { type: 'unknown' }
}

/** Esplora's names for the script types. */
export const ESPLORA_SCRIPT_TYPE: Record<ScriptType, string> = {
  p2pkh: 'p2pkh',
  p2sh: 'p2sh',
  p2wpkh: 'v0_p2wpkh',
  p2wsh: 'v0_p2wsh',
  p2tr: 'v1_p2tr',
  op_return: 'op_return',
  unknown: 'unknown',
}

export function scriptToAddress(script: Uint8Array, net: Network): string | null {
  const info = classifyScript(script)
  switch (info.type) {
    case 'p2pkh':
      return base58CheckEncode(net.p2pkh, info.program!)
    case 'p2sh':
      return base58CheckEncode(net.p2sh, info.program!)
    case 'p2wpkh':
    case 'p2wsh':
      return segwitEncode(net.hrp, 0, info.program!)
    case 'p2tr':
      return segwitEncode(net.hrp, 1, info.program!)
    default:
      return null
  }
}

/** Address -> scriptPubKey, or null when it is not a valid address on `net`. */
export function addressToScript(addr: string, net: Network): Uint8Array | null {
  const seg = segwitDecode(addr, net.hrp)
  if (seg) {
    if (seg.version === 0) return concat(Uint8Array.of(0x00, seg.program.length), seg.program)
    if (seg.version === 1 && seg.program.length === 32) return concat(Uint8Array.of(0x51, 0x20), seg.program)
    // Future witness versions: OP_n <push program>.
    return concat(Uint8Array.of(0x50 + seg.version, seg.program.length), seg.program)
  }
  const b58 = base58CheckDecode(addr)
  if (b58 && b58.payload.length === 20) {
    if (b58.version === net.p2pkh) return concat(Uint8Array.of(0x76, 0xa9, 0x14), b58.payload, Uint8Array.of(0x88, 0xac))
    if (b58.version === net.p2sh) return concat(Uint8Array.of(0xa9, 0x14), b58.payload, Uint8Array.of(0x87))
  }
  return null
}
