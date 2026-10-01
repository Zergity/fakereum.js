// The three signature-hash algorithms: legacy, BIP143 (segwit v0) and BIP341
// (taproot). Each returns the 32-byte digest a signature commits to.

import { concat, sha256, sha256d, taggedHash, u32le, u64le, varbytes, varint } from './bytes'
import { serializeOutpoint, serializeOutput, type BtcTx, type TxOut } from './tx'

export const SIGHASH_ALL = 0x01
export const SIGHASH_NONE = 0x02
export const SIGHASH_SINGLE = 0x03
export const SIGHASH_ANYONECANPAY = 0x80

const ZERO32: Uint8Array = new Uint8Array(32)

/** Legacy sighash. `scriptCode` is the previous output's scriptPubKey (P2PKH has no OP_CODESEPARATOR). */
export function legacySighash(tx: BtcTx, idx: number, scriptCode: Uint8Array, hashType: number): Uint8Array {
  const base = hashType & 0x1f
  // Consensus quirk: SIGHASH_SINGLE with no matching output signs the constant 1.
  if (base === SIGHASH_SINGLE && idx >= tx.outputs.length) {
    const one = new Uint8Array(32)
    one[0] = 1
    return one
  }
  const acp = (hashType & SIGHASH_ANYONECANPAY) !== 0
  const ins = acp ? [idx] : tx.inputs.map((_, i) => i)
  const parts: Uint8Array[] = [u32le(tx.version), varint(ins.length)]
  for (const j of ins) {
    const inp = tx.inputs[j]!
    const blanked = (base === SIGHASH_NONE || base === SIGHASH_SINGLE) && j !== idx
    parts.push(
      serializeOutpoint(inp.txid, inp.vout),
      varbytes(j === idx ? scriptCode : new Uint8Array(0)),
      u32le(blanked ? 0 : inp.sequence),
    )
  }
  let outs: TxOut[]
  if (base === SIGHASH_NONE) outs = []
  else if (base === SIGHASH_SINGLE) {
    // Earlier outputs are blanked to value -1 with an empty script.
    outs = tx.outputs.slice(0, idx + 1).map((o, i) => (i === idx ? o : { value: -1n, script: new Uint8Array(0) }))
  } else outs = tx.outputs
  parts.push(varint(outs.length))
  for (const o of outs) parts.push(serializeOutput(o))
  parts.push(u32le(tx.locktime), u32le(hashType))
  return sha256d(concat(...parts))
}

/** BIP143 sighash for a segwit v0 input. `scriptCode` is the already-built code (P2WPKH: the P2PKH template). */
export function segwitV0Sighash(
  tx: BtcTx,
  idx: number,
  scriptCode: Uint8Array,
  value: bigint,
  hashType: number,
): Uint8Array {
  const base = hashType & 0x1f
  const acp = (hashType & SIGHASH_ANYONECANPAY) !== 0
  const inp = tx.inputs[idx]!
  const hashPrevouts = acp ? ZERO32 : sha256d(concat(...tx.inputs.map((i) => serializeOutpoint(i.txid, i.vout))))
  const hashSequence =
    !acp && base !== SIGHASH_SINGLE && base !== SIGHASH_NONE
      ? sha256d(concat(...tx.inputs.map((i) => u32le(i.sequence))))
      : ZERO32
  let hashOutputs: Uint8Array = ZERO32
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) {
    hashOutputs = sha256d(concat(...tx.outputs.map(serializeOutput)))
  } else if (base === SIGHASH_SINGLE && idx < tx.outputs.length) {
    hashOutputs = sha256d(serializeOutput(tx.outputs[idx]!))
  }
  return sha256d(
    concat(
      u32le(tx.version),
      hashPrevouts,
      hashSequence,
      serializeOutpoint(inp.txid, inp.vout),
      varbytes(scriptCode),
      u64le(value),
      u32le(inp.sequence),
      hashOutputs,
      u32le(tx.locktime),
      u32le(hashType),
    ),
  )
}

const TAPROOT_HASH_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83])

/**
 * BIP341 sighash for a key-path spend (ext_flag 0). `prevouts` covers every
 * input of `tx`. Returns null for a hash type taproot does not define.
 */
export function taprootKeyPathSighash(
  tx: BtcTx,
  idx: number,
  prevouts: TxOut[],
  hashType: number,
  annex?: Uint8Array,
): Uint8Array | null {
  if (!TAPROOT_HASH_TYPES.has(hashType)) return null
  const outType = hashType === 0x00 ? SIGHASH_ALL : hashType & 0x03
  const acp = (hashType & SIGHASH_ANYONECANPAY) !== 0
  if (outType === SIGHASH_SINGLE && idx >= tx.outputs.length) return null

  const parts: Uint8Array[] = [Uint8Array.of(hashType), u32le(tx.version), u32le(tx.locktime)]
  if (!acp) {
    parts.push(
      sha256(concat(...tx.inputs.map((i) => serializeOutpoint(i.txid, i.vout)))),
      sha256(concat(...prevouts.map((p) => u64le(p.value)))),
      sha256(concat(...prevouts.map((p) => varbytes(p.script)))),
      sha256(concat(...tx.inputs.map((i) => u32le(i.sequence)))),
    )
  }
  if (outType !== SIGHASH_NONE && outType !== SIGHASH_SINGLE) {
    parts.push(sha256(concat(...tx.outputs.map(serializeOutput))))
  }
  parts.push(Uint8Array.of(annex ? 1 : 0)) // spend_type = ext_flag*2 + annex_present
  if (acp) {
    const inp = tx.inputs[idx]!
    const prev = prevouts[idx]!
    parts.push(serializeOutpoint(inp.txid, inp.vout), u64le(prev.value), varbytes(prev.script), u32le(inp.sequence))
  } else {
    parts.push(u32le(idx))
  }
  if (annex) parts.push(sha256(varbytes(annex)))
  if (outType === SIGHASH_SINGLE) parts.push(sha256(serializeOutput(tx.outputs[idx]!)))
  return taggedHash('TapSighash', Uint8Array.of(0x00), ...parts)
}
