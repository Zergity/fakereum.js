// Bitcoin transaction wire format: parse, serialize, txid / wtxid, weight.

import {
  Reader,
  bytesToHex,
  concat,
  hexToBytes,
  reversed,
  sha256d,
  u32le,
  u64le,
  varbytes,
  varint,
} from './bytes'

export interface TxIn {
  /** Previous txid in display (big-endian) hex, as explorers print it. */
  txid: string
  vout: number
  scriptSig: Uint8Array
  sequence: number
  witness: Uint8Array[]
}

export interface TxOut {
  value: bigint
  script: Uint8Array
}

export interface BtcTx {
  version: number
  inputs: TxIn[]
  outputs: TxOut[]
  locktime: number
}

export const NULL_TXID = '00'.repeat(32)
export const MAX_MONEY = 21_000_000n * 100_000_000n
/** Standardness cap on a transaction's weight. */
export const MAX_STANDARD_WEIGHT = 400_000

const MAX_SCRIPT_BYTES = 10_000

/** Decode a raw transaction (legacy or segwit). Throws on any malformed or trailing data. */
export function parseTx(raw: Uint8Array): BtcTx {
  const r = new Reader(raw)
  const version = r.u32() | 0
  let segwit = false
  // A segwit marker is a zero "input count" followed by the 0x01 flag.
  if (raw[4] === 0x00 && raw[5] === 0x01) {
    r.bytes(2)
    segwit = true
  }
  const nIn = r.varint()
  if (nIn > r.remaining / 41) throw new Error('bad input count')
  const inputs: TxIn[] = []
  for (let i = 0; i < nIn; i++) {
    const txid = bytesToHex(reversed(r.bytes(32)))
    const vout = r.u32()
    const scriptSig = r.varbytes()
    if (scriptSig.length > MAX_SCRIPT_BYTES) throw new Error('scriptSig too large')
    inputs.push({ txid, vout, scriptSig: scriptSig.slice(), sequence: r.u32(), witness: [] })
  }
  const nOut = r.varint()
  if (nOut > r.remaining / 9) throw new Error('bad output count')
  const outputs: TxOut[] = []
  for (let i = 0; i < nOut; i++) {
    const value = r.u64()
    const script = r.varbytes()
    if (script.length > MAX_SCRIPT_BYTES) throw new Error('scriptPubKey too large')
    outputs.push({ value, script: script.slice() })
  }
  if (segwit) {
    for (const inp of inputs) {
      const n = r.varint()
      if (n > r.remaining) throw new Error('bad witness count')
      for (let j = 0; j < n; j++) inp.witness.push(r.varbytes().slice())
    }
    // BIP144: a segwit-flagged tx whose witnesses are all empty is invalid.
    if (inputs.every((i) => i.witness.length === 0)) throw new Error('superfluous witness record')
  }
  const locktime = r.u32()
  if (r.remaining !== 0) throw new Error('trailing bytes after transaction')
  return { version, inputs, outputs, locktime }
}

export const serializeOutpoint = (txid: string, vout: number): Uint8Array =>
  concat(reversed(hexToBytes(txid)), u32le(vout))

export const serializeOutput = (o: TxOut): Uint8Array => concat(u64le(o.value), varbytes(o.script))

export function serializeTx(tx: BtcTx, withWitness = true): Uint8Array {
  const witnessed = withWitness && tx.inputs.some((i) => i.witness.length > 0)
  const parts: Uint8Array[] = [u32le(tx.version)]
  if (witnessed) parts.push(Uint8Array.of(0x00, 0x01))
  parts.push(varint(tx.inputs.length))
  for (const i of tx.inputs) {
    parts.push(serializeOutpoint(i.txid, i.vout), varbytes(i.scriptSig), u32le(i.sequence))
  }
  parts.push(varint(tx.outputs.length))
  for (const o of tx.outputs) parts.push(serializeOutput(o))
  if (witnessed) {
    for (const i of tx.inputs) {
      parts.push(varint(i.witness.length))
      for (const w of i.witness) parts.push(varbytes(w))
    }
  }
  parts.push(u32le(tx.locktime))
  return concat(...parts)
}

export function txid(tx: BtcTx): string {
  return bytesToHex(reversed(sha256d(serializeTx(tx, false))))
}

export function wtxid(tx: BtcTx): string {
  return bytesToHex(reversed(sha256d(serializeTx(tx, true))))
}

export function txWeight(tx: BtcTx): number {
  return serializeTx(tx, false).length * 3 + serializeTx(tx, true).length
}

export const vsizeOf = (weight: number): number => Math.ceil(weight / 4)

export const isCoinbaseShaped = (tx: BtcTx): boolean =>
  tx.inputs.length === 1 && tx.inputs[0]!.txid === NULL_TXID && tx.inputs[0]!.vout === 0xffffffff

export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`
