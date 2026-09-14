// Read-through upstream state reader with a TTL cache. Mirrors fetcher.go.
// The cache map is owned by the Durable Object (in-memory, lost on eviction =
// just a re-fetch), keyed by (method, params). GetBalanceUncached bypasses it
// so the replay guard's one-time check can't be fed a stale dapp-poll value.
//
// Two additions over the Go fetcher, both aimed at the Workers subrequest cap
// (50 external fetches per invocation on Free):
//   - prefetchState(): packs many cold reads into batched JSON-RPC POSTs (the
//     cap counts HTTP requests, not RPC calls) and seeds the TTL cache, so a
//     lazily-forked tx costs ~2-3 subrequests instead of one per account/slot.
//   - an optional CodeStore (DO storage, which does NOT count as a subrequest)
//     persists eth_getCode results across DO evictions. Code is big and nearly
//     immutable, so it gets a long TTL; balances/nonces/slots stay on the
//     short in-memory TTL only.

import type { Upstream, BatchCall } from './upstream'
import type { JsonValue } from './rpc'
import { hexToBytes, toBigInt, toHash32Hex, ZERO_HASH, type Hex } from './lib/hex'

// Persisted code entries live this long. Code changes upstream are rare
// (proxy upgrades point at NEW addresses; the sandbox overlay always wins over
// this cache anyway), but EIP-7702 delegations and CREATE2 redeploys do exist,
// so entries expire rather than living forever.
const CODE_STORE_TTL_MS = 24 * 3600 * 1000

export interface PersistedCode {
  code: string // eth_getCode result, 0x-hex
  expiresAt: number
}

/** Durable persistence hook for code entries (backed by DO storage). */
export interface CodeStore {
  get(addr: string): Promise<PersistedCode | undefined>
  put(addr: string, entry: PersistedCode): Promise<void>
}

/**
 * The read surface ForkingStateManager needs. Fetcher satisfies it (lazy
 * upstream fetch on miss); MissRecorder satisfies it too (zero on miss,
 * recording what a speculative run WOULD have fetched).
 */
export interface StateReader {
  getBalance(addr: Hex): Promise<bigint>
  getNonce(addr: Hex): Promise<bigint>
  getCode(addr: Hex): Promise<Uint8Array>
  getStorageAt(addr: Hex, key32: Hex): Promise<Hex>
}

export interface BlockCtx {
  number: bigint
  time: bigint
  baseFee: bigint
  gasLimit: bigint
  coinbase: Hex
  difficulty: bigint
  mixHash: Hex // 32 bytes (prevRandao post-merge)
  hash: Hex
}

interface CacheEntry {
  value: JsonValue
  expiresAt: number
}

export class Fetcher {
  /**
   * `balanceMultiplier` scales every native balance read through the cached
   * paths (getBalance / peekBalance / the prefetch cache they consume): the
   * sandbox shows an account that has no sandbox balance yet as holding
   * upstream × multiplier. The uncached getBalanceUncached stays raw — it
   * answers "does this account hold real funds?" for the replay guard.
   */
  constructor(
    private readonly up: Upstream,
    private readonly ttlMs: number,
    private readonly cache: Map<string, CacheEntry>,
    private readonly codeStore?: CodeStore,
    private readonly balanceMultiplier: bigint = 1n,
  ) {}

  private keyFor(method: string, params: unknown[]): string {
    return method + ':' + JSON.stringify(params)
  }

  private memGet(key: string): JsonValue | undefined {
    if (this.ttlMs <= 0) return undefined
    const e = this.cache.get(key)
    return e && Date.now() < e.expiresAt ? e.value : undefined
  }

  private memSet(key: string, value: JsonValue): void {
    if (this.ttlMs > 0) this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  private async cached(method: string, params: unknown[]): Promise<JsonValue> {
    const key = this.keyFor(method, params)
    const hit = this.memGet(key)
    if (hit !== undefined) return hit
    const result = await this.up.callResult(method, params)
    this.memSet(key, result)
    return result
  }

  /** eth_getCode with the extra durable tier: memory -> CodeStore -> upstream. */
  private async codeHex(addr: string): Promise<JsonValue> {
    const a = addr.toLowerCase()
    const key = this.keyFor('eth_getCode', [a, 'latest'])
    const hit = this.memGet(key)
    if (hit !== undefined) return hit
    if (this.codeStore) {
      const stored = await this.codeStore.get(a)
      if (stored && Date.now() < stored.expiresAt) {
        this.memSet(key, stored.code)
        return stored.code
      }
    }
    const result = await this.up.callResult('eth_getCode', [a, 'latest'])
    this.memSet(key, result)
    if (this.codeStore && typeof result === 'string') {
      await this.codeStore.put(a, { code: result, expiresAt: Date.now() + CODE_STORE_TTL_MS })
    }
    return result
  }

  // --- cache peeks (never touch upstream; used by MissRecorder) ------------

  async peekBalance(addr: Hex): Promise<bigint | undefined> {
    const v = this.memGet(this.keyFor('eth_getBalance', [addr, 'latest']))
    return typeof v === 'string' ? toBigInt(v) * this.balanceMultiplier : undefined
  }

  async peekNonce(addr: Hex): Promise<bigint | undefined> {
    const v = this.memGet(this.keyFor('eth_getTransactionCount', [addr, 'latest']))
    return typeof v === 'string' ? toBigInt(v) : undefined
  }

  async peekCode(addr: Hex): Promise<Uint8Array | undefined> {
    const a = addr.toLowerCase()
    const key = this.keyFor('eth_getCode', [a, 'latest'])
    let v = this.memGet(key)
    if (v === undefined && this.codeStore) {
      const stored = await this.codeStore.get(a)
      if (stored && Date.now() < stored.expiresAt) {
        this.memSet(key, stored.code)
        v = stored.code
      }
    }
    if (typeof v !== 'string') return undefined
    return v && v !== '0x' ? hexToBytes(v) : new Uint8Array(0)
  }

  async peekStorageAt(addr: Hex, key32: Hex): Promise<Hex | undefined> {
    const v = this.memGet(this.keyFor('eth_getStorageAt', [addr, key32, 'latest']))
    return typeof v === 'string' ? toHash32Hex(v || '0x') : undefined
  }

  // --- batched prefetch ----------------------------------------------------

  /**
   * Warm the cache for a set of accounts (balance+nonce+code each) and storage
   * slots in as few HTTP subrequests as possible (one batch POST per 100
   * reads). Reads already covered by the memory cache or the CodeStore are
   * skipped; per-read failures inside the batch are ignored — the lazy
   * per-read path re-fetches (or surfaces the error) on actual use. No-op when
   * caching is disabled (ttl<=0): there is nowhere to put the results.
   */
  async prefetchState(accounts: Hex[], slots: Array<[Hex, Hex]>): Promise<void> {
    if (this.ttlMs <= 0) return
    const now = Date.now()
    const reads: BatchCall[] = []
    const seen = new Set<string>()
    const want = (method: string, params: unknown[]): void => {
      const k = this.keyFor(method, params)
      if (seen.has(k)) return
      seen.add(k)
      if (this.memGet(k) === undefined) reads.push({ method, params })
    }
    for (const a of accounts) {
      const addr = a.toLowerCase()
      want('eth_getBalance', [addr, 'latest'])
      want('eth_getTransactionCount', [addr, 'latest'])
      const ck = this.keyFor('eth_getCode', [addr, 'latest'])
      if (!seen.has(ck)) {
        seen.add(ck)
        if (this.memGet(ck) === undefined) {
          const stored = this.codeStore ? await this.codeStore.get(addr) : undefined
          if (stored && now < stored.expiresAt) this.memSet(ck, stored.code)
          else reads.push({ method: 'eth_getCode', params: [addr, 'latest'] })
        }
      }
    }
    for (const [a, s] of slots) {
      want('eth_getStorageAt', [a.toLowerCase(), toHash32Hex(s), 'latest'])
    }
    if (reads.length === 0) return
    const resps = await this.up.batch(reads)
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]!
      const resp = resps[i]
      if (!resp || resp.error || resp.result === undefined) continue
      this.memSet(this.keyFor(read.method, read.params), resp.result as JsonValue)
      if (read.method === 'eth_getCode' && this.codeStore && typeof resp.result === 'string') {
        await this.codeStore.put(read.params[0] as string, {
          code: resp.result,
          expiresAt: now + CODE_STORE_TTL_MS,
        })
      }
    }
  }

  /**
   * Ask upstream which accounts/slots a call would touch (eth_createAccessList
   * against upstream@latest, optionally with geth-style state overrides so the
   * simulation follows SANDBOX state — overlay code/storage plus a funded
   * sender, since replay-guarded senders hold zero upstream balance and some
   * nodes charge real gas fees in the simulation). Best-effort: null when the
   * method is unsupported or upstream unreachable. A reverted simulation still
   * yields the partial list of what was touched up to the failure.
   *
   * If the override-carrying call is refused (no override support, fee charge,
   * ...), retry once without `from`/`value`/overrides: the sender defaults to
   * the zero address, so msg.sender-keyed slots go missing — the lazy per-read
   * path covers those — but the bulk (code, config, pool/oracle state) still
   * lands in the list.
   */
  async createAccessList(
    call: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ): Promise<Array<{ address: string; storageKeys: string[] }> | null> {
    try {
      const params: unknown[] = overrides ? [call, 'latest', overrides] : [call, 'latest']
      let resp = await this.up.call('eth_createAccessList', params)
      if (resp.error && call['from'] !== undefined) {
        const senderless = { ...call }
        delete senderless['from']
        delete senderless['value'] // the zero-address default sender holds only dust
        resp = await this.up.call('eth_createAccessList', [senderless, 'latest'])
      }
      const r = resp.result as { accessList?: unknown } | undefined
      if (!r || !Array.isArray(r.accessList)) return null
      return r.accessList as Array<{ address: string; storageKeys: string[] }>
    } catch {
      return null
    }
  }

  async chainId(): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_chainId', [])))
  }

  /** The sandbox's view of an account with no sandbox balance: upstream × multiplier. */
  async getBalance(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_getBalance', [addr, 'latest']))) * this.balanceMultiplier
  }

  /** Raw upstream balance, unscaled and uncached — the replay guard's question. */
  async getBalanceUncached(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.up.callResult('eth_getBalance', [addr, 'latest'])))
  }

  async getNonce(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_getTransactionCount', [addr, 'latest'])))
  }

  async getCode(addr: Hex): Promise<Uint8Array> {
    const s = asString(await this.codeHex(addr))
    return s && s !== '0x' ? hexToBytes(s) : new Uint8Array(0)
  }

  async getStorageAt(addr: Hex, key32: Hex): Promise<Hex> {
    const s = asString(await this.cached('eth_getStorageAt', [addr, key32, 'latest']))
    return toHash32Hex(s || '0x')
  }

  async gasPrice(): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_gasPrice', [])))
  }

  async getLatestBlock(): Promise<BlockCtx> {
    return parseTip(await this.cached('eth_getBlockByNumber', ['latest', false]))
  }

  // Bypass the TTL cache. eth_sendRawTransaction must build on the true current
  // tip — its block.number/block.timestamp have to be live, not a value cached
  // up to ttlMs ago. Like getBalanceUncached, this deliberately does not seed
  // the shared cache.
  async getLatestBlockUncached(): Promise<BlockCtx> {
    return parseTip(await this.up.callResult('eth_getBlockByNumber', ['latest', false]))
  }
}

function parseTip(head: JsonValue): BlockCtx {
  const h = head as Record<string, JsonValue> | null
  if (!h || typeof h !== 'object') throw new Error('upstream tip: empty block')
  const num = asOptString(h['number'])
  const ts = asOptString(h['timestamp'])
  const base = asOptString(h['baseFeePerGas'])
  const gl = asOptString(h['gasLimit'])
  const diff = asOptString(h['difficulty'])
  return {
    number: num ? toBigInt(num) : 0n,
    time: ts ? toBigInt(ts) : 0n,
    baseFee: base ? toBigInt(base) : 0n,
    gasLimit: gl ? toBigInt(gl) : 0n,
    coinbase: (asOptString(h['miner']) ?? '0x0000000000000000000000000000000000000000') as Hex,
    difficulty: diff ? toBigInt(diff) : 0n,
    mixHash: toHash32Hex(asOptString(h['mixHash']) ?? '0x'),
    hash: (asOptString(h['hash']) ?? toHash32Hex('0x')) as Hex,
  }
}

function asString(v: JsonValue): string {
  return typeof v === 'string' ? v : ''
}
function asOptString(v: JsonValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * StateReader for speculative warm-up runs: answers from the Fetcher's caches
 * only, records every miss (returning zero/empty for it) instead of issuing an
 * upstream fetch. After the run, the recorded set is batch-fetched in one POST
 * and the run repeats — see Executor.warmupRounds. Zero-valued guesses can
 * steer a speculative run down a wrong branch; that self-corrects next round
 * once the true values are cached, and the REAL run only ever sees the real
 * Fetcher, so correctness never depends on this class.
 */
export class MissRecorder implements StateReader {
  readonly accounts = new Set<Hex>()
  readonly slots: Array<[Hex, Hex]> = []
  /** cache keys of everything recorded, for cross-round progress tracking */
  readonly keys = new Set<string>()
  private readonly slotSeen = new Set<string>()

  constructor(private readonly real: Fetcher) {}

  get missCount(): number {
    return this.keys.size
  }

  private markAccount(addr: Hex, kind: string): void {
    this.accounts.add(addr.toLowerCase() as Hex)
    this.keys.add(kind + ':' + addr.toLowerCase())
  }

  async getBalance(addr: Hex): Promise<bigint> {
    const v = await this.real.peekBalance(addr)
    if (v !== undefined) return v
    this.markAccount(addr, 'bal')
    return 0n
  }

  async getNonce(addr: Hex): Promise<bigint> {
    const v = await this.real.peekNonce(addr)
    if (v !== undefined) return v
    this.markAccount(addr, 'nonce')
    return 0n
  }

  async getCode(addr: Hex): Promise<Uint8Array> {
    const v = await this.real.peekCode(addr)
    if (v !== undefined) return v
    this.markAccount(addr, 'code')
    return new Uint8Array(0)
  }

  async getStorageAt(addr: Hex, key32: Hex): Promise<Hex> {
    const v = await this.real.peekStorageAt(addr, key32)
    if (v !== undefined) return v
    const a = addr.toLowerCase() as Hex
    const sk = a + ':' + key32
    if (!this.slotSeen.has(sk)) {
      this.slotSeen.add(sk)
      this.slots.push([a, key32])
      this.keys.add('slot:' + sk)
    }
    return ZERO_HASH
  }
}
