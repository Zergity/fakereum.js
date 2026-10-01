// Input verification. This is not a script interpreter: it recognises the
// standard single-signature spends wallets actually produce (P2PKH, P2WPKH,
// P2SH-P2WPKH, taproot key path), verifies the signature against the right
// sighash, and rejects anything else with a clear reason. Multisig, script-path
// taproot and arbitrary scripts are future work.

import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { concat, equalBytes, hash160 } from './bytes'
import { classifyScript } from './address'
import { legacySighash, segwitV0Sighash, taprootKeyPathSighash } from './sighash'
import type { BtcTx, TxOut } from './tx'

/** Data pushes of a push-only script, or null if it holds anything else. */
function pushes(script: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = []
  let i = 0
  while (i < script.length) {
    const op = script[i++]!
    let len: number
    if (op === 0x00) {
      out.push(new Uint8Array(0))
      continue
    } else if (op >= 0x01 && op <= 0x4b) len = op
    else if (op === 0x4c) {
      if (i + 1 > script.length) return null
      len = script[i++]!
    } else if (op === 0x4d) {
      if (i + 2 > script.length) return null
      len = script[i]! | (script[i + 1]! << 8)
      i += 2
    } else return null
    if (i + len > script.length) return null
    out.push(script.subarray(i, i + len))
    i += len
  }
  return out
}

function ecdsaOk(sigWithType: Uint8Array, pubkey: Uint8Array, digestOf: (hashType: number) => Uint8Array): string | null {
  if (sigWithType.length < 9) return 'signature too short'
  const hashType = sigWithType[sigWithType.length - 1]!
  const der = sigWithType.subarray(0, sigWithType.length - 1)
  let ok = false
  try {
    ok = secp256k1.verify(der, digestOf(hashType), pubkey, { format: 'der', prehash: false })
  } catch {
    return 'non-canonical signature or public key'
  }
  return ok ? null : 'signature does not match'
}

const p2pkhCode = (h160: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac))

/** null = the input is validly signed; otherwise the reason it is not. */
export function verifyInput(tx: BtcTx, idx: number, prevouts: TxOut[]): string | null {
  const inp = tx.inputs[idx]!
  const prev = prevouts[idx]!
  const info = classifyScript(prev.script)

  switch (info.type) {
    case 'p2pkh': {
      if (inp.witness.length > 0) return 'unexpected witness on a legacy input'
      const p = pushes(inp.scriptSig)
      if (!p || p.length !== 2) return 'P2PKH scriptSig must be <sig> <pubkey>'
      const [sig, pub] = p as [Uint8Array, Uint8Array]
      if (!equalBytes(hash160(pub), info.program!)) return 'public key does not hash to the address'
      return ecdsaOk(sig, pub, (ht) => legacySighash(tx, idx, prev.script, ht))
    }
    case 'p2wpkh':
      return verifyP2wpkh(tx, idx, prev, info.program!, true)
    case 'p2sh': {
      // Only the nested P2WPKH form: scriptSig is one push of 0x0014<h160>.
      const p = pushes(inp.scriptSig)
      if (!p || p.length !== 1) return 'unsupported P2SH redeem script (only P2SH-P2WPKH is verified)'
      const redeem = p[0]!
      if (!equalBytes(hash160(redeem), info.program!)) return 'redeem script does not hash to the address'
      const inner = classifyScript(redeem)
      if (inner.type !== 'p2wpkh') return 'unsupported P2SH redeem script (only P2SH-P2WPKH is verified)'
      return verifyP2wpkh(tx, idx, prev, inner.program!, false)
    }
    case 'p2tr': {
      if (inp.scriptSig.length > 0) return 'taproot input must have an empty scriptSig'
      let w = inp.witness
      let annex: Uint8Array | undefined
      if (w.length >= 2 && w[w.length - 1]![0] === 0x50) {
        annex = w[w.length - 1]!
        w = w.slice(0, -1)
      }
      if (w.length !== 1) return 'unsupported taproot spend (only key-path is verified)'
      const sig = w[0]!
      if (sig.length !== 64 && sig.length !== 65) return 'bad schnorr signature size'
      let hashType = 0x00
      if (sig.length === 65) {
        hashType = sig[64]!
        if (hashType === 0x00) return 'explicit SIGHASH_DEFAULT is not allowed'
      }
      const digest = taprootKeyPathSighash(tx, idx, prevouts, hashType, annex)
      if (!digest) return 'invalid taproot sighash type'
      try {
        return schnorr.verify(sig.subarray(0, 64), digest, info.program!) ? null : 'signature does not match'
      } catch {
        return 'non-canonical signature or public key'
      }
    }
    case 'p2wsh':
      return 'unsupported script type: P2WSH spends are not verified yet'
    default:
      return 'unsupported script type'
  }
}

function verifyP2wpkh(
  tx: BtcTx,
  idx: number,
  prev: TxOut,
  h160: Uint8Array,
  native: boolean,
): string | null {
  const inp = tx.inputs[idx]!
  if (native && inp.scriptSig.length > 0) return 'native segwit input must have an empty scriptSig'
  if (inp.witness.length !== 2) return 'P2WPKH witness must be <sig> <pubkey>'
  const [sig, pub] = inp.witness as [Uint8Array, Uint8Array]
  if (pub.length !== 33) return 'P2WPKH requires a compressed public key'
  if (!equalBytes(hash160(pub), h160)) return 'public key does not hash to the address'
  const code = p2pkhCode(h160)
  return ecdsaOk(sig, pub, (ht) => segwitV0Sighash(tx, idx, code, prev.value, ht))
}
