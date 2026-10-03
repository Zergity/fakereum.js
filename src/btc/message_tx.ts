// Signed-message spends of real outputs — the Bitcoin counterpart of the EVM
// sandbox's EIP-191 transactions. A real output cannot be spent by an ordinary
// signed transaction here (the same bytes would be valid on the real chain), so
// the owner signs a message that describes the whole transaction instead. A
// message signature commits to the BIP-322 virtual transaction, never to a
// spend of the output, so it cannot be turned into one.

import { addressToScript, scriptToAddress, type Network } from './address'
import { bytesToHex } from './bytes'
import { verifyBip322 } from './bip322'
import { BtcError } from './ledger'
import { networkLabel } from './admin'
import { txid as txidOf, type BtcTx, type TxOut } from './tx'

/** The txid the transaction would have with every scriptSig and witness removed. */
export function strippedTxid(tx: BtcTx): string {
  return txidOf({
    ...tx,
    inputs: tx.inputs.map((i) => ({ ...i, scriptSig: new Uint8Array(0), witness: [] })),
  })
}

function who(script: Uint8Array, net: Network): string {
  return scriptToAddress(script, net) ?? `script:${bytesToHex(script)}`
}

/** The text every signer of a transaction signs. Amounts are whole satoshis. */
export function txMessage(net: Network, tx: BtcTx, prevouts: TxOut[]): string {
  const inValue = prevouts.reduce((n, p) => n + p.value, 0n)
  const outValue = tx.outputs.reduce((n, o) => n + o.value, 0n)
  const lines = [`Fakereum transaction on ${networkLabel(net)}`, `Id: ${strippedTxid(tx)}`, 'Inputs:']
  tx.inputs.forEach((inp, i) => lines.push(`  ${inp.txid}:${inp.vout} ${who(prevouts[i]!.script, net)} ${prevouts[i]!.value} sat`))
  lines.push('Outputs:')
  for (const o of tx.outputs) lines.push(`  ${who(o.script, net)} ${o.value} sat`)
  lines.push(`Fee: ${inValue - outValue} sat`)
  return lines.join('\n')
}

/** Distinct addresses of the real inputs, in input order: who must sign. */
export function signersFor(net: Network, prevouts: TxOut[], realFlags: boolean[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  prevouts.forEach((p, i) => {
    if (!realFlags[i]) return
    const hex = bytesToHex(p.script)
    if (seen.has(hex)) return
    seen.add(hex)
    out.push(who(p.script, net))
  })
  return out
}

/** Verify every {address, signature} over `message`; returns the script hexes they authorise. */
export function verifySigners(net: Network, message: string, sigs: unknown): Set<string> {
  if (!Array.isArray(sigs)) throw new BtcError('signatures must be an array of {address, signature}', -32602)
  const out = new Set<string>()
  for (const s of sigs) {
    const address = (s as any)?.address
    const signature = (s as any)?.signature
    if (typeof address !== 'string' || typeof signature !== 'string') {
      throw new BtcError('each signature needs an address and a signature string', -32602)
    }
    const script = addressToScript(address, net)
    if (!script) throw new BtcError(`invalid ${net.name} address: ${address}`, -32602)
    const why = verifyBip322(address, net, message, signature)
    if (why) throw new BtcError(`bad signature from ${address}: ${why}`, -26)
    out.add(bytesToHex(script))
  }
  return out
}
