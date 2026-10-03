// BIP-322 "simple" message signatures: the proof-of-address-ownership wallets
// produce for signMessage on segwit and taproot addresses. Used for admin
// actions and for authorising sandbox spends of real outputs (a signature over
// a message cannot be replayed as a Bitcoin transaction).
//
// The verifier builds the two virtual transactions of the spec and hands the
// signed input to the same verifyInput used for real spends, so P2WPKH,
// P2SH-P2WPKH and taproot key-path addresses are covered; legacy P2PKH needs
// BIP-137 and is refused with a clear message.

import { concat, equalBytes, hash160, Reader, taggedHash } from './bytes'
import { addressToScript, classifyScript, type Network } from './address'
import { txid as txidOf, type BtcTx } from './tx'
import { verifyInput } from './verify'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export function messageHash(message: string): Uint8Array {
  return taggedHash('BIP0322-signed-message', utf8(message))
}

/** The to_spend / to_sign pair for `message` and the address script `script`. */
export function bip322Txs(script: Uint8Array, message: string): { toSpend: BtcTx; toSign: BtcTx } {
  const toSpend: BtcTx = {
    version: 0,
    locktime: 0,
    inputs: [
      {
        txid: '00'.repeat(32),
        vout: 0xffffffff,
        scriptSig: concat(Uint8Array.of(0x00, 0x20), messageHash(message)),
        sequence: 0,
        witness: [],
      },
    ],
    outputs: [{ value: 0n, script }],
  }
  const toSign: BtcTx = {
    version: 0,
    locktime: 0,
    inputs: [{ txid: txidOf(toSpend), vout: 0, scriptSig: new Uint8Array(0), sequence: 0, witness: [] }],
    outputs: [{ value: 0n, script: Uint8Array.of(0x6a) }],
  }
  return { toSpend, toSign }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Decode the "simple" signature: a serialized witness stack, base64 encoded. */
export function parseSimpleSignature(sig: string): Uint8Array[] {
  const r = new Reader(base64ToBytes(sig))
  const n = r.varint()
  if (n < 1 || n > 4) throw new Error('unexpected witness size')
  const items: Uint8Array[] = []
  for (let i = 0; i < n; i++) items.push(r.varbytes())
  if (r.remaining !== 0) throw new Error('trailing data after the witness')
  return items
}

/**
 * null = `sig` is a valid BIP-322 simple signature of `message` by `address`;
 * otherwise the reason it is not.
 */
export function verifyBip322(address: string, net: Network, message: string, sig: string): string | null {
  const script = addressToScript(address, net)
  if (!script) return `invalid ${net.name} address`
  const info = classifyScript(script)
  if (info.type === 'p2pkh') return 'legacy P2PKH addresses sign with BIP-137, which is not supported; use a segwit or taproot address'
  if (info.type !== 'p2wpkh' && info.type !== 'p2sh' && info.type !== 'p2tr') return 'unsupported address type for BIP-322'

  let witness: Uint8Array[]
  try {
    witness = parseSimpleSignature(sig)
  } catch (e) {
    return 'malformed signature: ' + (e as Error).message
  }
  const { toSign } = bip322Txs(script, message)
  const inp = toSign.inputs[0]!
  inp.witness = witness
  if (info.type === 'p2sh') {
    // Nested segwit: the redeem script is rebuilt from the witness public key.
    const pub = witness[1]
    if (witness.length !== 2 || !pub || pub.length !== 33) return 'P2SH-P2WPKH signature must be <sig> <pubkey>'
    const redeem = concat(Uint8Array.of(0x00, 0x14), hash160(pub))
    if (!equalBytes(hash160(redeem), info.program!)) return 'public key does not match the address'
    inp.scriptSig = concat(Uint8Array.of(redeem.length), redeem)
  }
  return verifyInput(toSign, 0, [{ value: 0n, script }])
}
