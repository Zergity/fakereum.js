// Esplora- and bitcoind-shaped JSON for sandbox transactions and blocks.

import { ESPLORA_SCRIPT_TYPE, classifyScript, scriptToAddress, type Network } from './address'
import { bytesToHex, hexToBytes, reversed, sha256d } from './bytes'
import type { BlockRec, Ledger, TxRecord } from './ledger'
import { outpointKey, serializeTx, txid as txidOf, wtxid as wtxidOf } from './tx'

const BTC = 100_000_000

export function esploraStatus(l: Ledger, height: number, time: number) {
  const b = l.blockAt(height)
  return { confirmed: true, block_height: height, block_hash: b?.hash ?? l.anchor.hash, block_time: time }
}

function outJson(o: { value: bigint; script: Uint8Array }, net: Network) {
  const addr = scriptToAddress(o.script, net)
  return {
    scriptpubkey: bytesToHex(o.script),
    scriptpubkey_type: ESPLORA_SCRIPT_TYPE[classifyScript(o.script).type],
    ...(addr ? { scriptpubkey_address: addr } : {}),
    value: Number(o.value),
  }
}

/** GET /tx/:txid */
export function esploraTx(l: Ledger, rec: TxRecord, net: Network) {
  const { stored, tx } = rec
  const faucet = stored.kind === 'faucet'
  return {
    txid: stored.txid,
    version: tx.version,
    locktime: tx.locktime,
    size: serializeTx(tx).length,
    weight: rec.weight,
    fee: Number(stored.fee),
    vin: tx.inputs.map((i) => {
      const prev = l.prevout(outpointKey(i.txid, i.vout))
      return {
        txid: i.txid,
        vout: i.vout,
        // A faucet mint spends a synthetic outpoint that has no output behind it.
        prevout: prev && !faucet ? outJson(prev, net) : null,
        scriptsig: bytesToHex(i.scriptSig),
        witness: i.witness.map(bytesToHex),
        is_coinbase: false,
        sequence: i.sequence,
      }
    }),
    vout: tx.outputs.map((o) => outJson(o, net)),
    status: esploraStatus(l, stored.height, stored.time),
    ...(stored.signedBy?.length
      ? {
          fakereum_signed_by: stored.signedBy
            .map((sh) => scriptToAddress(hexToBytes(sh), net))
            .filter((a): a is string => a !== null),
        }
      : {}),
  }
}

/** GET /block/:hash */
export function esploraBlock(l: Ledger, b: BlockRec) {
  const weight = b.txids.reduce((n, id) => n + (l.txs.get(id)?.weight ?? 0), 0)
  return {
    id: b.hash,
    height: b.height,
    version: 0x20000000,
    timestamp: b.time,
    tx_count: b.txids.length,
    size: Math.ceil(weight / 4) + 80,
    weight: weight + 320,
    merkle_root: bytesToHex(reversed(sha256d(new TextEncoder().encode(b.txids.join(','))))),
    previousblockhash: b.prev,
    mediantime: b.time,
    nonce: 0,
    bits: 0x207fffff,
    difficulty: 1,
  }
}

/** bitcoind getrawtransaction verbose=true */
export function coreTx(l: Ledger, rec: TxRecord, net: Network) {
  const { stored, tx } = rec
  const tip = l.tip()
  const faucet = stored.kind === 'faucet'
  const block = l.blockAt(stored.height)
  return {
    txid: stored.txid,
    hash: wtxidOf(tx),
    version: tx.version,
    size: serializeTx(tx).length,
    vsize: rec.vsize,
    weight: rec.weight,
    locktime: tx.locktime,
    vin: tx.inputs.map((i) => ({
      txid: i.txid,
      vout: i.vout,
      scriptSig: { hex: bytesToHex(i.scriptSig) },
      ...(i.witness.length ? { txinwitness: i.witness.map(bytesToHex) } : {}),
      sequence: i.sequence,
    })),
    vout: tx.outputs.map((o, n) => {
      const addr = scriptToAddress(o.script, net)
      return {
        value: Number(o.value) / BTC,
        n,
        scriptPubKey: {
          hex: bytesToHex(o.script),
          type: classifyScript(o.script).type,
          ...(addr ? { address: addr } : {}),
        },
      }
    }),
    hex: bytesToHex(serializeTx(tx)),
    ...(faucet ? { fakereum: { faucet: true } } : {}),
    blockhash: block?.hash,
    confirmations: tip.height - stored.height + 1,
    time: stored.time,
    blocktime: stored.time,
  }
}

export { txidOf }
