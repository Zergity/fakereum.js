// The sandbox chain: synthetic blocks stacked on a pinned upstream tip, the
// outputs those blocks created, and which of them have been spent. Pure and
// synchronous — no I/O — so the Durable Object only has to persist what this
// produces, and tests can drive it directly.
//
// Scope: only outputs created inside the sandbox are spendable here. A spend of
// a real upstream output would be byte-identical to a valid mainnet
// transaction (Bitcoin transactions carry no chain id), so it is refused; see
// BtcError 'bad-txns-inputs-missingorspent' below.

import { bytesToHex, concat, hexToBytes, reversed, sha256, sha256d, u64le } from './bytes'
import {
  MAX_MONEY,
  MAX_STANDARD_WEIGHT,
  isCoinbaseShaped,
  outpointKey,
  parseTx,
  serializeTx,
  txWeight,
  vsizeOf,
  txid as computeTxid,
  type BtcTx,
  type TxOut,
} from './tx'
import { verifyInput } from './verify'

/** A rejection shaped like Bitcoin Core's: a short reason string and an RPC error code. */
export class BtcError extends Error {
  constructor(
    readonly reason: string,
    readonly code = -26,
  ) {
    super(reason)
  }
}

export interface Anchor {
  height: number
  hash: string
  time: number
}

export interface BlockRec {
  height: number
  hash: string
  prev: string
  time: number
  txids: string[]
}

/** What is persisted per transaction; everything else is derived from the hex. */
export interface StoredTx {
  txid: string
  hex: string
  height: number
  time: number
  /** Fee in satoshis, decimal string. */
  fee: string
  kind: 'tx' | 'faucet'
}

export interface TxRecord {
  stored: StoredTx
  tx: BtcTx
  weight: number
  vsize: number
}

export interface OutRec {
  txid: string
  vout: number
  value: bigint
  script: Uint8Array
}

export interface Plan {
  tx: BtcTx
  txid: string
  hex: string
  fee: bigint
  weight: number
  vsize: number
}

export interface LedgerOptions {
  /** Minimum relay feerate, satoshis per 1000 vbytes. */
  minRelayFeePerKvB: number
}

const LOCKTIME_THRESHOLD = 500_000_000
const FINAL_SEQUENCE = 0xffffffff
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export class Ledger {
  blocks: BlockRec[] = []
  readonly txs = new Map<string, TxRecord>()
  readonly outputs = new Map<string, OutRec>()
  /** outpoint -> txid of the sandbox transaction that spent it. */
  readonly spent = new Map<string, string>()
  private readonly byScript = new Map<string, string[]>()
  private readonly scriptTxs = new Map<string, string[]>()
  private readonly byScripthash = new Map<string, string>()
  private faucetCount = 0

  constructor(
    readonly anchor: Anchor,
    private readonly opts: LedgerOptions,
  ) {}

  // --- chain position -------------------------------------------------------

  tip(): Anchor {
    const b = this.blocks[this.blocks.length - 1]
    return b ? { height: b.height, hash: b.hash, time: b.time } : this.anchor
  }

  /** Median time past of the tip, over the last 11 blocks (anchor included). */
  medianTimePast(): number {
    const times = [this.anchor.time, ...this.blocks.map((b) => b.time)].slice(-11).sort((a, b) => a - b)
    return times[Math.floor(times.length / 2)]!
  }

  blockAt(height: number): BlockRec | undefined {
    return this.blocks[height - this.anchor.height - 1]
  }

  blockByHash(hash: string): BlockRec | undefined {
    return this.blocks.find((b) => b.hash === hash)
  }

  // --- persistence replay ---------------------------------------------------

  /** Rebuild state from persisted rows (blocks and txs in height order). */
  load(blocks: BlockRec[], txs: StoredTx[]): void {
    this.blocks = [...blocks].sort((a, b) => a.height - b.height)
    for (const s of [...txs].sort((a, b) => a.height - b.height)) {
      const tx = parseTx(hexToBytes(s.hex))
      const weight = txWeight(tx)
      this.index({ stored: s, tx, weight, vsize: vsizeOf(weight) })
    }
  }

  // --- reads ---------------------------------------------------------------

  /** Unspent sandbox outputs paying `scriptHex`, oldest first. */
  unspentFor(scriptHex: string): OutRec[] {
    const out: OutRec[] = []
    for (const key of this.byScript.get(scriptHex) ?? []) {
      if (!this.spent.has(key)) out.push(this.outputs.get(key)!)
    }
    return out
  }

  /** Sandbox txs that paid to or spent from `scriptHex`, newest first. */
  txsFor(scriptHex: string): TxRecord[] {
    return [...(this.scriptTxs.get(scriptHex) ?? [])].reverse().map((id) => this.txs.get(id)!)
  }

  scriptForScripthash(h: string): string | undefined {
    return this.byScripthash.get(h)
  }

  stats(scriptHex: string): {
    funded_txo_count: number
    funded_txo_sum: number
    spent_txo_count: number
    spent_txo_sum: number
    tx_count: number
  } {
    let fc = 0
    let fs = 0n
    let sc = 0
    let ss = 0n
    for (const key of this.byScript.get(scriptHex) ?? []) {
      const o = this.outputs.get(key)!
      fc++
      fs += o.value
      if (this.spent.has(key)) {
        sc++
        ss += o.value
      }
    }
    return {
      funded_txo_count: fc,
      funded_txo_sum: Number(fs),
      spent_txo_count: sc,
      spent_txo_sum: Number(ss),
      tx_count: (this.scriptTxs.get(scriptHex) ?? []).length,
    }
  }

  // --- writes --------------------------------------------------------------

  /** Validate a raw transaction against the sandbox state without changing it. */
  plan(raw: Uint8Array): Plan {
    let tx: BtcTx
    try {
      tx = parseTx(raw)
    } catch (e) {
      throw new BtcError('TX decode failed: ' + (e as Error).message, -22)
    }
    if (tx.inputs.length === 0) throw new BtcError('bad-txns-vin-empty')
    if (tx.outputs.length === 0) throw new BtcError('bad-txns-vout-empty')
    if (isCoinbaseShaped(tx)) throw new BtcError('coinbase')

    const weight = txWeight(tx)
    if (weight > MAX_STANDARD_WEIGHT) throw new BtcError('tx-size')
    const vsize = vsizeOf(weight)

    let outTotal = 0n
    for (const o of tx.outputs) {
      if (o.value > MAX_MONEY) throw new BtcError('bad-txns-vout-toolarge')
      outTotal += o.value
      if (outTotal > MAX_MONEY) throw new BtcError('bad-txns-txouttotal-toolarge')
    }

    const id = computeTxid(tx)
    if (this.txs.has(id)) throw new BtcError('txn-already-known')

    const seen = new Set<string>()
    const prevouts: TxOut[] = []
    let inTotal = 0n
    for (const inp of tx.inputs) {
      const key = outpointKey(inp.txid, inp.vout)
      if (seen.has(key)) throw new BtcError('bad-txns-inputs-duplicate')
      seen.add(key)
      const prev = this.outputs.get(key)
      if (!prev) {
        throw new BtcError(
          `bad-txns-inputs-missingorspent: ${key} is not an output of this sandbox ` +
            '(spending real upstream outputs is not supported: the signed transaction would also be valid on the real chain)',
        )
      }
      if (this.spent.has(key)) throw new BtcError('bad-txns-inputs-missingorspent: ' + key + ' is already spent')
      prevouts.push({ value: prev.value, script: prev.script })
      inTotal += prev.value
    }
    if (inTotal < outTotal) throw new BtcError('bad-txns-in-belowout')

    this.checkFinal(tx)

    for (let i = 0; i < tx.inputs.length; i++) {
      const why = verifyInput(tx, i, prevouts)
      if (why) throw new BtcError(`mandatory-script-verify-flag-failed (input ${i}: ${why})`)
    }

    const fee = inTotal - outTotal
    if (fee * 1000n < BigInt(this.opts.minRelayFeePerKvB) * BigInt(vsize)) {
      throw new BtcError(`min relay fee not met, ${fee} < ${Math.ceil((this.opts.minRelayFeePerKvB * vsize) / 1000)}`, -26)
    }
    return { tx, txid: id, hex: bytesToHex(serializeTx(tx)), fee, weight, vsize }
  }

  /** Mine a validated transaction into a block of its own. */
  commit(plan: Plan, now: number): { block: BlockRec; stored: StoredTx } {
    if (this.txs.has(plan.txid)) throw new BtcError('txn-already-known')
    const block = this.nextBlock([plan.txid], now)
    const stored: StoredTx = {
      txid: plan.txid,
      hex: plan.hex,
      height: block.height,
      time: block.time,
      fee: plan.fee.toString(),
      kind: 'tx',
    }
    this.blocks.push(block)
    this.index({ stored, tx: plan.tx, weight: plan.weight, vsize: plan.vsize })
    return { block, stored }
  }

  /**
   * Create `sats` out of thin air for `script`, as a one-output transaction in
   * its own block. Its single input is a synthetic outpoint no real chain has,
   * so the transaction can never be replayed on mainnet.
   */
  faucet(script: Uint8Array, sats: bigint, now: number): { block: BlockRec; stored: StoredTx } {
    if (sats <= 0n || sats > MAX_MONEY) throw new BtcError('amount out of range', -8)
    const seed = sha256d(concat(utf8('fakereum-faucet'), u64le(BigInt(this.faucetCount))))
    const tx: BtcTx = {
      version: 2,
      inputs: [{ txid: bytesToHex(reversed(seed)), vout: 0, scriptSig: new Uint8Array(0), sequence: FINAL_SEQUENCE, witness: [] }],
      outputs: [{ value: sats, script }],
      locktime: 0,
    }
    const weight = txWeight(tx)
    const id = computeTxid(tx)
    const block = this.nextBlock([id], now)
    const stored: StoredTx = {
      txid: id,
      hex: bytesToHex(serializeTx(tx)),
      height: block.height,
      time: block.time,
      fee: '0',
      kind: 'faucet',
    }
    this.blocks.push(block)
    this.index({ stored, tx, weight, vsize: vsizeOf(weight) })
    return { block, stored }
  }

  /** Append `n` empty blocks. */
  mine(n: number, now: number): BlockRec[] {
    const out: BlockRec[] = []
    for (let i = 0; i < n; i++) {
      const b = this.nextBlock([], now)
      this.blocks.push(b)
      out.push(b)
    }
    return out
  }

  // --- internals -----------------------------------------------------------

  private checkFinal(tx: BtcTx): void {
    if (tx.locktime === 0) return
    if (tx.inputs.every((i) => i.sequence === FINAL_SEQUENCE)) return
    const limit = tx.locktime < LOCKTIME_THRESHOLD ? this.tip().height + 1 : this.medianTimePast()
    if (tx.locktime >= limit) throw new BtcError('non-final')
  }

  private nextBlock(txids: string[], now: number): BlockRec {
    const tip = this.tip()
    const height = tip.height + 1
    const time = Math.max(now, tip.time + 1)
    const hash = bytesToHex(sha256(utf8(`fakereum:${tip.hash}:${height}:${time}:${txids.join(',')}`)))
    return { height, hash, prev: tip.hash, time, txids }
  }

  private index(rec: TxRecord): void {
    const { stored, tx } = rec
    this.txs.set(stored.txid, rec)
    if (stored.kind === 'faucet') this.faucetCount++

    const touched = new Set<string>()
    if (stored.kind === 'tx') {
      for (const inp of tx.inputs) {
        const key = outpointKey(inp.txid, inp.vout)
        this.spent.set(key, stored.txid)
        const prev = this.outputs.get(key)
        if (prev) touched.add(bytesToHex(prev.script))
      }
    }
    tx.outputs.forEach((o, vout) => {
      const key = outpointKey(stored.txid, vout)
      this.outputs.set(key, { txid: stored.txid, vout, value: o.value, script: o.script })
      const sh = bytesToHex(o.script)
      const list = this.byScript.get(sh)
      if (list) list.push(key)
      else this.byScript.set(sh, [key])
      this.byScripthash.set(bytesToHex(reversed(sha256(o.script))), sh)
      touched.add(sh)
    })
    for (const sh of touched) {
      const list = this.scriptTxs.get(sh)
      if (list) list.push(stored.txid)
      else this.scriptTxs.set(sh, [stored.txid])
    }
  }
}
