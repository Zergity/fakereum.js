// Shared helpers for the Bitcoin sandbox tests: deterministic P2WPKH keys and a
// signer that spends sandbox outputs the way a wallet would.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { concat, hash160 } from '../src/btc/bytes'
import { NETWORKS, scriptToAddress } from '../src/btc/address'
import type { Ledger } from '../src/btc/ledger'
import { SIGHASH_ALL, segwitV0Sighash } from '../src/btc/sighash'
import { serializeTx, type BtcTx } from '../src/btc/tx'

export function key(n: number) {
  const sk = new Uint8Array(32)
  sk[31] = n
  const pub = secp256k1.getPublicKey(sk, true)
  const script = concat(Uint8Array.of(0x00, 0x14), hash160(pub))
  return { sk, pub, script, address: scriptToAddress(script, NETWORKS.mainnet)! }
}

/** Spend `outpoints` (all owned by `owner`, P2WPKH) into `outputs`, signing each input. */
export function spend(
  ledger: Ledger,
  owner: ReturnType<typeof key>,
  outpoints: string[],
  outputs: { value: bigint; script: Uint8Array }[],
  extra: Partial<BtcTx> = {},
): Uint8Array {
  const tx: BtcTx = {
    version: 2,
    inputs: outpoints.map((o) => {
      const [txid, vout] = o.split(':')
      return { txid: txid!, vout: Number(vout), scriptSig: new Uint8Array(0), sequence: 0xfffffffd, witness: [] }
    }),
    outputs,
    locktime: 0,
    ...extra,
  }
  const code = concat(Uint8Array.of(0x76, 0xa9, 0x14), hash160(owner.pub), Uint8Array.of(0x88, 0xac))
  tx.inputs.forEach((inp, i) => {
    const prev = ledger.outputs.get(`${inp.txid}:${inp.vout}`)
    const value = prev ? prev.value : 0n
    const digest = segwitV0Sighash(tx, i, code, value, SIGHASH_ALL)
    const sig = secp256k1.sign(digest, owner.sk, { prehash: false, format: 'der' })
    inp.witness = [concat(sig, Uint8Array.of(SIGHASH_ALL)), owner.pub]
  })
  return serializeTx(tx)
}


export const alice = key(1)
export const bob = key(2)
