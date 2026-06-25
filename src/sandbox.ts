// In-memory store of sandbox-executed txs + their receipts/logs, mirrored to DO
// storage (keys "sandbox:tx:<hash>", plus "sandbox:nextSeq"/"sandbox:nextLog").
// Ports sandbox.go. Mutation methods return what changed so the DO persists
// incrementally. The flat log list is rebuilt from stored txs at init.

import type { StoredLog, StoredTx } from './types'
import { addrEq, addrKey, toBigInt, type Hex } from './lib/hex'

export interface LogFilter {
  fromBlock: bigint | null
  toBlock: bigint | null
  blockHash: Hex | null
  addresses: string[] // addrKeys
  topics: Array<Hex[] | null> // per-position OR-set; null = wildcard
  /**
   * Optional Etherscan cross-position OR grouping (topicI_J_opr=or). Each group
   * lists topic positions OR'd together; a log matches when EVERY group has at
   * least one member position matching, and the groups are AND'd with each other.
   * Set only on the Etherscan getLogs path; when undefined the standard
   * eth_getLogs per-position AND applies.
   */
  topicGroups?: number[][]
}

export class Sandbox {
  private txs = new Map<string, StoredTx>() // hashKey(lowercased) -> tx
  private allLogs: StoredLog[] = [] // sorted by logIndex
  private nextLog = 0
  private nextSeq = 0

  // --- init / persistence -------------------------------------------------

  /** Load a persisted tx (called per "sandbox:tx:*" key at DO init). */
  load(tx: StoredTx): void {
    this.txs.set(tx.hash.toLowerCase(), tx)
  }

  /** Finalize after all loads: rebuild the flat log list and counters. */
  finalizeLoad(nextSeq: number, nextLog: number): void {
    this.allLogs = []
    for (const tx of this.txs.values()) this.allLogs.push(...tx.logs)
    this.allLogs.sort((a, b) => toBigInt(a.logIndex) < toBigInt(b.logIndex) ? -1 : 1)
    // Defensive: counters must be > any stored value.
    let maxSeq = nextSeq
    let maxLog = nextLog
    for (const tx of this.txs.values()) {
      if (tx.seq + 1 > maxSeq) maxSeq = tx.seq + 1
      for (const l of tx.logs) {
        const li = Number(toBigInt(l.logIndex))
        if (li + 1 > maxLog) maxLog = li + 1
      }
    }
    this.nextSeq = maxSeq
    this.nextLog = maxLog
  }

  counters(): { nextSeq: number; nextLog: number } {
    return { nextSeq: this.nextSeq, nextLog: this.nextLog }
  }

  /**
   * Store a freshly-executed tx. Assigns its submission `seq` and a global
   * `logIndex` to each of its logs, appends to the flat list. Returns the
   * stored tx (the caller persists it + the counters).
   */
  store(tx: StoredTx): StoredTx {
    tx.seq = this.nextSeq++
    for (const l of tx.logs) {
      l.logIndex = ('0x' + (this.nextLog++).toString(16)) as Hex
      this.allLogs.push(l)
    }
    this.txs.set(tx.hash.toLowerCase(), tx)
    return tx
  }

  // --- reads --------------------------------------------------------------

  get(hash: Hex): StoredTx | undefined {
    return this.txs.get(hash.toLowerCase())
  }

  /** All txs, newest block first (then by hash) — for /txs. */
  allEntries(): StoredTx[] {
    return [...this.txs.values()].sort((a, b) => {
      const ba = toBigInt(a.blockNumber)
      const bb = toBigInt(b.blockNumber)
      if (ba !== bb) return ba > bb ? -1 : 1
      return a.hash.toLowerCase() < b.hash.toLowerCase() ? -1 : 1
    })
  }

  /** Txs touching addr (from/to/contract/created), block asc then hash. */
  entriesForAddress(addr: Hex): StoredTx[] {
    const out: StoredTx[] = []
    for (const tx of this.txs.values()) {
      if (
        addrEq(tx.from, addr) ||
        (tx.to && addrEq(tx.to, addr)) ||
        (tx.contractAddress && addrEq(tx.contractAddress, addr)) ||
        tx.createdContracts.some((c) => addrEq(c, addr))
      ) {
        out.push(tx)
      }
    }
    return out.sort((a, b) => {
      const ba = toBigInt(a.blockNumber)
      const bb = toBigInt(b.blockNumber)
      if (ba !== bb) return ba < bb ? -1 : 1
      return a.hash.toLowerCase() < b.hash.toLowerCase() ? -1 : 1
    })
  }

  /** Highest-seq (most recent) tx, or undefined when empty. */
  lastEntry(): StoredTx | undefined {
    let last: StoredTx | undefined
    for (const tx of this.txs.values()) if (!last || tx.seq > last.seq) last = tx
    return last
  }

  /** Every tx with seq >= the given seq, newest first (LIFO undo order). */
  entriesAtOrAfterSeq(seq: number): StoredTx[] {
    return [...this.txs.values()].filter((t) => t.seq >= seq).sort((a, b) => b.seq - a.seq)
  }

  filterLogs(f: LogFilter): StoredLog[] {
    return this.allLogs.filter((l) => logMatches(f, l))
  }

  // --- mutations ----------------------------------------------------------

  /** Drop a tx + its logs from the flat list. Returns true if removed. */
  removeTx(hash: Hex): boolean {
    const key = hash.toLowerCase()
    const tx = this.txs.get(key)
    if (!tx) return false
    this.txs.delete(key)
    if (tx.logs.length > 0) {
      const removed = new Set(tx.logs.map((l) => l.logIndex))
      this.allLogs = this.allLogs.filter((l) => !removed.has(l.logIndex))
    }
    return true
  }

  /** Drop every tx matching the predicate. Returns the removed hashes. */
  removeWhere(match: (tx: StoredTx) => boolean): Hex[] {
    const removedHashes: Hex[] = []
    const removedLogIdx = new Set<Hex>()
    for (const [key, tx] of [...this.txs.entries()]) {
      if (match(tx)) {
        this.txs.delete(key)
        removedHashes.push(tx.hash)
        for (const l of tx.logs) removedLogIdx.add(l.logIndex)
      }
    }
    if (removedLogIdx.size > 0) {
      this.allLogs = this.allLogs.filter((l) => !removedLogIdx.has(l.logIndex))
    }
    return removedHashes
  }
}

// --- log filter matching (sandbox.go LogFilter.match) ---------------------

export function logMatches(f: LogFilter, l: StoredLog): boolean {
  if (f.blockHash && f.blockHash.toLowerCase() !== l.blockHash.toLowerCase()) return false
  if (f.fromBlock !== null || f.toBlock !== null) {
    const bn = toBigInt(l.blockNumber)
    if (f.fromBlock !== null && bn < f.fromBlock) return false
    if (f.toBlock !== null && bn > f.toBlock) return false
  }
  if (f.addresses.length > 0) {
    if (!f.addresses.includes(addrKey(l.address))) return false
  }
  if (f.topicGroups && f.topicGroups.length > 0) {
    // Etherscan topicI_J_opr semantics: OR within a group, AND across groups.
    // A group matches when ANY of its positions equals its filter value, so a
    // 3-topic OR returns the union of the per-position hits rather than their
    // (usually empty) intersection.
    for (const group of f.topicGroups) {
      if (!group.some((i) => topicPosMatches(f.topics[i] ?? null, l.topics[i]))) return false
    }
    return true
  }
  // Standard eth_getLogs: every set position must match (AND across positions).
  for (let i = 0; i < f.topics.length; i++) {
    if (!topicPosMatches(f.topics[i] ?? null, l.topics[i])) return false
  }
  return true
}

/**
 * One topic position. A wildcard (null/empty want-set) matches anything;
 * otherwise the log must carry a value at this position equal to one of the
 * wanted values (case-insensitive).
 */
function topicPosMatches(want: Hex[] | null, have: Hex | undefined): boolean {
  if (!want || want.length === 0) return true
  if (have === undefined) return false
  return want.some((t) => t.toLowerCase() === have.toLowerCase())
}

/** Parse eth_getLogs params[0] into a LogFilter. */
export function parseLogFilter(params: unknown[]): LogFilter {
  const f: LogFilter = {
    fromBlock: null,
    toBlock: null,
    blockHash: null,
    addresses: [],
    topics: [],
  }
  const obj = params[0]
  if (!obj || typeof obj !== 'object') return f
  const o = obj as Record<string, unknown>

  f.fromBlock = parseBlockTag(o['fromBlock'])
  f.toBlock = parseBlockTag(o['toBlock'])
  if (typeof o['blockHash'] === 'string') f.blockHash = o['blockHash'] as Hex

  const addr = o['address']
  if (typeof addr === 'string') f.addresses = [addrKey(addr)]
  else if (Array.isArray(addr)) f.addresses = addr.filter((x): x is string => typeof x === 'string').map(addrKey)

  const topics = o['topics']
  if (Array.isArray(topics)) {
    for (const t of topics) {
      if (t === null || t === undefined) f.topics.push(null)
      else if (typeof t === 'string') f.topics.push([t as Hex])
      else if (Array.isArray(t)) f.topics.push(t.filter((x): x is string => typeof x === 'string') as Hex[])
      else f.topics.push(null)
    }
  }

  // Etherscan cross-position OR grouping (set only by the getLogs proxy path).
  const groups = o['topicGroups']
  if (Array.isArray(groups)) {
    const parsed = groups
      .filter((g): g is unknown[] => Array.isArray(g))
      .map((g) => g.filter((n): n is number => typeof n === 'number'))
      .filter((g) => g.length > 0)
    if (parsed.length > 0) f.topicGroups = parsed
  }
  return f
}

function parseBlockTag(v: unknown): bigint | null {
  if (typeof v !== 'string') return null
  switch (v.toLowerCase()) {
    case 'earliest':
      return 0n
    case 'latest':
    case 'pending':
    case 'safe':
    case 'finalized':
    case '':
      return null
    default:
      return toBigInt(v)
  }
}
