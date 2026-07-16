// Read-through upstream state reader with a TTL cache. Mirrors fetcher.go.
// The cache map is owned by the Durable Object (in-memory, lost on eviction =
// just a re-fetch), keyed by (method, params). GetBalanceUncached bypasses it
// so the replay guard's one-time check can't be fed a stale dapp-poll value.

import type { Upstream } from './upstream'
import type { JsonValue } from './rpc'
import { hexToBytes, toBigInt, toHash32Hex, type Hex } from './lib/hex'

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
  constructor(
    private readonly up: Upstream,
    private readonly ttlMs: number,
    private readonly cache: Map<string, CacheEntry>,
  ) {}

  private async cached(method: string, params: unknown[]): Promise<JsonValue> {
    const key = method + ':' + JSON.stringify(params)
    if (this.ttlMs > 0) {
      const e = this.cache.get(key)
      if (e && Date.now() < e.expiresAt) return e.value
    }
    const result = await this.up.callResult(method, params)
    if (this.ttlMs > 0) {
      this.cache.set(key, { value: result, expiresAt: Date.now() + this.ttlMs })
    }
    return result
  }

  async chainId(): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_chainId', [])))
  }

  async getBalance(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_getBalance', [addr, 'latest'])))
  }

  async getBalanceUncached(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.up.callResult('eth_getBalance', [addr, 'latest'])))
  }

  async getNonce(addr: Hex): Promise<bigint> {
    return toBigInt(asString(await this.cached('eth_getTransactionCount', [addr, 'latest'])))
  }

  async getCode(addr: Hex): Promise<Uint8Array> {
    const s = asString(await this.cached('eth_getCode', [addr, 'latest']))
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
