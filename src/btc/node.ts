// The Bitcoin sandbox's request handler. Storage is a small interface so the
// Durable Object (src/btc/sandbox_do.ts) is a thin wrapper and the whole node
// can be exercised in tests against an in-memory store.
//
// Surfaces:
//   /api/...      Esplora-compatible REST (what wallets and BDK/electrs clients speak)
//   /rpc          bitcoind-style JSON-RPC subset + fakereum_* helpers
//   /fakereum     discovery document
//   /             landing page

import { addressToScript, scriptToAddress } from './address'
import { bytesToHex, concat, hexToBytes } from './bytes'
import type { BtcConfig } from './config'
import { EsploraHttpError, type EsploraUpstream } from './esplora'
import { BtcError, Ledger, type Anchor, type BlockRec, type Plan, type StoredTx } from './ledger'
import { coreTx, esploraBlock, esploraStatus, esploraTx } from './render'
import { esc } from '../ui/html'
import { applyNoStore, corsHeaders } from '../lib/cors'
import { RateLimiter } from '../lib/rate_limit'
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  isBatch,
  makeError,
  makeResult,
  paramsArray,
  type RpcRequest,
  type RpcResponse,
} from '../rpc'

export interface BtcStorage {
  get<T>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
  list<T>(prefix: string): Promise<Map<string, T>>
}

const ANCHOR_KEY = 'btc:anchor'
const BLOCK_PREFIX = 'btc:block:'
const TX_PREFIX = 'btc:tx:'
/** DO storage accepts at most 128 keys per put(). */
const PUT_CHUNK = 128
const MAX_MINE = 1000

const FEE_TARGETS = [...Array.from({ length: 25 }, (_, i) => i + 1), 144, 504, 1008]
const RPC_NO_SUCH_TX = -5
const RPC_INVALID_PARAMETER = -8

export class BtcNode {
  private ledger: Ledger | null = null
  private anchoring: Promise<void> | null = null
  private readonly limiter: RateLimiter | null

  constructor(
    private readonly storage: BtcStorage,
    private readonly cfg: BtcConfig,
    private readonly upstream: EsploraUpstream,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.limiter = RateLimiter.fromConfig(cfg.rateLimitRps, cfg.rateLimitExempt)
  }

  // --- startup ---------------------------------------------------------------

  /**
   * Load persisted state, or pin the fork point on first use. The anchor is
   * stored the first time it is read, so the sandbox's timeline starts from one
   * upstream block for good.
   */
  private async ready(): Promise<Ledger> {
    if (this.ledger) return this.ledger
    if (!this.anchoring) {
      this.anchoring = (async () => {
        let anchor = await this.storage.get<Anchor>(ANCHOR_KEY)
        if (!anchor) {
          anchor = this.upstream.configured
            ? await this.upstream.tip()
            : // Standalone: a fresh chain with its own genesis-like anchor.
              { height: 0, hash: '00'.repeat(31) + '01', time: this.nowSec() }
          await this.storage.put({ [ANCHOR_KEY]: anchor })
        }
        const l = new Ledger(anchor, { minRelayFeePerKvB: this.cfg.minRelayFeePerKvB })
        const blocks = [...(await this.storage.list<BlockRec>(BLOCK_PREFIX)).values()]
        const txs = [...(await this.storage.list<StoredTx>(TX_PREFIX)).values()]
        l.load(blocks, txs)
        this.ledger = l
      })().finally(() => {
        this.anchoring = null
      })
    }
    await this.anchoring
    return this.ledger!
  }

  private async persist(blocks: BlockRec[], txs: StoredTx[]): Promise<void> {
    const entries: [string, unknown][] = [
      ...blocks.map((b): [string, unknown] => [BLOCK_PREFIX + String(b.height).padStart(10, '0'), b]),
      ...txs.map((t): [string, unknown] => [TX_PREFIX + t.txid, t]),
    ]
    for (let i = 0; i < entries.length; i += PUT_CHUNK) {
      await this.storage.put(Object.fromEntries(entries.slice(i, i + PUT_CHUNK)))
    }
  }

  // --- HTTP entry ------------------------------------------------------------

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const cors = { origins: this.cfg.corsOrigins }

    if (request.method === 'OPTIONS') {
      const h = new Headers(corsHeaders(cors, origin))
      applyNoStore(h)
      return new Response(null, { status: 204, headers: h })
    }
    if (this.limiter) {
      const verdict = this.limiter.check(request.headers.get('CF-Connecting-IP') ?? 'unknown')
      if (!verdict.ok) {
        return this.decorate(
          origin,
          new Response('rate limit exceeded', { status: 429, headers: { 'Retry-After': String(verdict.retryAfter) } }),
        )
      }
    }

    let l: Ledger
    try {
      l = await this.ready()
    } catch (e) {
      return this.decorate(origin, text('upstream unavailable: ' + errMsg(e), 502))
    }

    const baseURL = selfBaseURL(request, url)
    const path = url.pathname
    let resp: Response
    try {
      if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        resp = this.landing(l, baseURL)
      } else if (path === '/fakereum' && request.method === 'GET') {
        resp = json(this.discovery(l, baseURL))
      } else if (path === '/rpc' && request.method === 'POST') {
        resp = await this.serveRpc(l, request)
      } else if (path === '/api' || path.startsWith('/api/')) {
        resp = await this.esplora(l, request, path.slice('/api'.length) || '/')
      } else {
        resp = text('not found', 404)
      }
    } catch (e) {
      resp = text('internal error: ' + errMsg(e), 500)
    }
    return this.decorate(origin, resp)
  }

  private decorate(origin: string | null, resp: Response): Response {
    const h = new Headers(resp.headers)
    for (const [k, v] of Object.entries(corsHeaders({ origins: this.cfg.corsOrigins }, origin))) h.set(k, v)
    applyNoStore(h)
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
  }

  // --- write paths (shared by REST and RPC) ------------------------------------

  /** Validate and mine a raw transaction. Synchronous end to end, so concurrent requests cannot interleave. */
  private submit(l: Ledger, hex: string): { plan: Plan; blocks: BlockRec[]; txs: StoredTx[] } {
    let raw: Uint8Array
    try {
      raw = hexToBytes(hex.trim())
    } catch {
      throw new BtcError('TX decode failed: not hex', -22)
    }
    const plan = l.plan(raw)
    const { block, stored } = l.commit(plan, this.nowSec())
    return { plan, blocks: [block], txs: [stored] }
  }

  private async sendRaw(l: Ledger, hex: string): Promise<string> {
    const { plan, blocks, txs } = this.submit(l, hex)
    await this.persist(blocks, txs)
    return plan.txid
  }

  private async faucet(l: Ledger, target: unknown, amount: unknown): Promise<string> {
    if (typeof target !== 'string') throw new BtcError('address required', RPC_INVALID_PARAMETER)
    const script = addressToScript(target, this.cfg.network)
    if (!script) throw new BtcError(`invalid ${this.cfg.network.name} address`, RPC_INVALID_PARAMETER)
    let sats: bigint
    try {
      if (typeof amount === 'string' ? !/^[0-9]+$/.test(amount) : !Number.isSafeInteger(amount)) throw new Error()
      sats = BigInt(amount as string | number)
    } catch {
      throw new BtcError('amount must be a whole number of satoshis', RPC_INVALID_PARAMETER)
    }
    if (sats <= 0n || sats > this.cfg.faucetMaxSats) {
      throw new BtcError(`amount must be between 1 and ${this.cfg.faucetMaxSats} satoshis`, RPC_INVALID_PARAMETER)
    }
    const { block, stored } = l.faucet(script, sats, this.nowSec())
    await this.persist([block], [stored])
    return stored.txid
  }

  private async mine(l: Ledger, n: unknown): Promise<string[]> {
    const count = n === undefined ? 1 : Number(n)
    if (!Number.isInteger(count) || count < 1 || count > MAX_MINE) {
      throw new BtcError(`block count must be between 1 and ${MAX_MINE}`, RPC_INVALID_PARAMETER)
    }
    const blocks = l.mine(count, this.nowSec())
    await this.persist(blocks, [])
    return blocks.map((b) => b.hash)
  }

  // --- JSON-RPC --------------------------------------------------------------

  private async serveRpc(l: Ledger, request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    if (isBatch(body)) return json(await Promise.all(body.map((r) => this.rpcOne(l, r))))
    return json(await this.rpcOne(l, body as RpcRequest))
  }

  private async rpcOne(l: Ledger, req: RpcRequest): Promise<RpcResponse> {
    if (!req || typeof req.method !== 'string') return makeError(req?.id, ERR_INVALID_PARAMS, 'invalid request')
    const p = paramsArray(req.params)
    try {
      return makeResult(req.id, await this.rpcMethod(l, req.method, p))
    } catch (e) {
      if (e instanceof BtcError) return makeError(req.id, e.code, e.reason)
      if (e instanceof RpcMethodNotFound) return makeError(req.id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`)
      return makeError(req.id, ERR_INTERNAL, errMsg(e))
    }
  }

  private async rpcMethod(l: Ledger, method: string, p: unknown[]): Promise<unknown> {
    const tip = l.tip()
    switch (method) {
      case 'getblockchaininfo':
        return {
          chain: this.cfg.network.coreChain,
          blocks: tip.height,
          headers: tip.height,
          bestblockhash: tip.hash,
          difficulty: 1,
          time: tip.time,
          mediantime: l.medianTimePast(),
          verificationprogress: 1,
          initialblockdownload: false,
          pruned: false,
          warnings: '',
          fakereum: true,
          forkHeight: l.anchor.height,
        }
      case 'getblockcount':
        return tip.height
      case 'getbestblockhash':
        return tip.hash
      case 'getblockhash': {
        const h = Number(p[0])
        if (!Number.isInteger(h) || h < 0 || h > tip.height) throw new BtcError('Block height out of range', -8)
        if (h > l.anchor.height) return l.blockAt(h)!.hash
        if (h === l.anchor.height) return l.anchor.hash
        if (!this.upstream.configured) throw new BtcError('Block height out of range', -8)
        return this.upstream.text(`/block-height/${h}`)
      }
      case 'getblock': {
        const b = typeof p[0] === 'string' ? l.blockByHash(p[0]) : undefined
        if (!b) throw new BtcError('Block not found (only sandbox blocks are served)', -5)
        const next = l.blockAt(b.height + 1)
        return {
          hash: b.hash,
          confirmations: tip.height - b.height + 1,
          height: b.height,
          version: 0x20000000,
          time: b.time,
          mediantime: b.time,
          nTx: b.txids.length,
          tx: b.txids,
          previousblockhash: b.prev,
          ...(next ? { nextblockhash: next.hash } : {}),
        }
      }
      case 'getrawtransaction': {
        const id = typeof p[0] === 'string' ? p[0].toLowerCase() : ''
        const rec = l.txs.get(id)
        const verbose = p[1] === true || p[1] === 1
        if (rec) return verbose ? coreTx(l, rec, this.cfg.network) : rec.stored.hex
        if (verbose) throw new BtcError('verbose output is only available for sandbox transactions', RPC_INVALID_PARAMETER)
        if (this.upstream.configured && /^[0-9a-f]{64}$/.test(id)) {
          try {
            return await this.upstream.text(`/tx/${id}/hex`)
          } catch (e) {
            if (!(e instanceof EsploraHttpError) || e.status !== 404) throw e
          }
        }
        throw new BtcError('No such mempool or blockchain transaction. Use gettransaction for wallet transactions.', RPC_NO_SUCH_TX)
      }
      case 'sendrawtransaction':
        if (typeof p[0] !== 'string') throw new BtcError('hex string required', RPC_INVALID_PARAMETER)
        return this.sendRaw(l, p[0])
      case 'testmempoolaccept': {
        const list = Array.isArray(p[0]) ? p[0] : []
        return list.map((hex) => {
          try {
            const plan = l.plan(hexToBytes(String(hex)))
            return {
              txid: plan.txid,
              allowed: true,
              vsize: plan.vsize,
              fees: { base: Number(plan.fee) / 1e8 },
            }
          } catch (e) {
            const reason = e instanceof BtcError ? e.reason : 'TX decode failed'
            return { txid: '', allowed: false, 'reject-reason': reason }
          }
        })
      }
      case 'estimatesmartfee':
        return { feerate: (this.cfg.feeRate * 1000) / 1e8, blocks: Number(p[0]) || 1 }
      case 'getmempoolinfo':
        return { loaded: true, size: 0, bytes: 0, usage: 0, total_fee: 0, mempoolminfee: this.cfg.minRelayFeePerKvB / 1e8, minrelaytxfee: this.cfg.minRelayFeePerKvB / 1e8 }
      case 'getrawmempool':
        return []
      case 'fakereum_faucet':
        return this.faucet(l, p[0], p[1])
      case 'fakereum_mine':
        return this.mine(l, p[0])
      case 'fakereum_info':
        return this.discovery(l, '')
      default:
        throw new RpcMethodNotFound()
    }
  }

  // --- Esplora REST ----------------------------------------------------------

  private async esplora(l: Ledger, request: Request, sub: string): Promise<Response> {
    if (request.method === 'POST' && sub === '/tx') {
      try {
        return text(await this.sendRaw(l, await request.text()))
      } catch (e) {
        if (e instanceof BtcError) {
          return text(`sendrawtransaction RPC error: ${JSON.stringify({ code: e.code, message: e.reason })}`, 400)
        }
        throw e
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405)

    const seg = sub.split('/').filter(Boolean)
    const [head, a, b, c, d] = seg
    const tip = l.tip()
    try {
      switch (head) {
        case 'blocks':
          if (a === 'tip' && b === 'height') return text(String(tip.height))
          if (a === 'tip' && b === 'hash') return text(tip.hash)
          break
        case 'block-height': {
          const h = Number(a)
          if (!Number.isInteger(h) || h < 0) return text('Invalid block height', 400)
          if (h > tip.height) return text('Block not found', 404)
          if (h > l.anchor.height) return text(l.blockAt(h)!.hash)
          if (h === l.anchor.height) return text(l.anchor.hash)
          return this.proxy(`/block-height/${h}`)
        }
        case 'block': {
          const blk = a ? l.blockByHash(a) : undefined
          if (!blk) return this.proxy(sub) // a real block, at or below the fork point
          if (!b) return json(esploraBlock(l, blk))
          if (b === 'status') {
            const next = l.blockAt(blk.height + 1)
            return json({ in_best_chain: true, height: blk.height, ...(next ? { next_best: next.hash } : {}) })
          }
          if (b === 'txids') return json(blk.txids)
          if (b === 'header') return text('')
          break
        }
        case 'tx': {
          const rec = a ? l.txs.get(a.toLowerCase()) : undefined
          if (!rec) return this.proxy(sub)
          if (!b) return json(esploraTx(l, rec, this.cfg.network))
          if (b === 'hex') return text(rec.stored.hex)
          if (b === 'raw') return new Response(hexToBytes(rec.stored.hex), { headers: { 'Content-Type': 'application/octet-stream' } })
          if (b === 'status') return json(esploraStatus(l, rec.stored.height, rec.stored.time))
          if (b === 'outspend' && c !== undefined) return json(this.outspend(l, rec.stored.txid, Number(c)))
          if (b === 'outspends') return json(rec.tx.outputs.map((_, i) => this.outspend(l, rec.stored.txid, i)))
          break
        }
        case 'address':
        case 'scripthash':
          return await this.addressRoutes(l, head, a, b, c, d)
        case 'fee-estimates':
          return json(Object.fromEntries(FEE_TARGETS.map((t) => [String(t), this.cfg.feeRate])))
        case 'mempool':
          if (!a) return json({ count: 0, vsize: 0, total_fee: 0, fee_histogram: [] })
          if (a === 'txids') return json([])
          if (a === 'recent') return json([])
          break
      }
    } catch (e) {
      return this.upstreamFailure(e)
    }
    return text('not found', 404)
  }

  private outspend(l: Ledger, id: string, vout: number) {
    const by = l.spent.get(`${id}:${vout}`)
    if (!by) return { spent: false }
    const rec = l.txs.get(by)!
    return {
      spent: true,
      txid: by,
      vin: rec.tx.inputs.findIndex((i) => i.txid === id && i.vout === vout),
      status: esploraStatus(l, rec.stored.height, rec.stored.time),
    }
  }

  private async addressRoutes(
    l: Ledger,
    kind: 'address' | 'scripthash',
    id: string | undefined,
    what: string | undefined,
    c: string | undefined,
    d: string | undefined,
  ): Promise<Response> {
    if (!id) return text('not found', 404)
    let scriptHex: string | undefined
    if (kind === 'address') {
      const script = addressToScript(id, this.cfg.network)
      if (!script) return text(`Invalid ${this.cfg.network.name} address`, 400)
      scriptHex = bytesToHex(script)
    } else {
      if (!/^[0-9a-f]{64}$/.test(id)) return text('Invalid scripthash', 400)
      scriptHex = l.scriptForScripthash(id)
    }
    const upstreamBase = `/${kind}/${id}`
    const net = this.cfg.network

    if (!what) {
      const up = this.upstream.configured ? await this.upstream.json<any>(upstreamBase) : { [kind]: id, chain_stats: zeroStats(), mempool_stats: zeroStats() }
      const mine = scriptHex ? l.stats(scriptHex) : zeroStats()
      const cs = up.chain_stats ?? zeroStats()
      return json({
        ...up,
        chain_stats: {
          funded_txo_count: cs.funded_txo_count + mine.funded_txo_count,
          funded_txo_sum: cs.funded_txo_sum + mine.funded_txo_sum,
          spent_txo_count: cs.spent_txo_count + mine.spent_txo_count,
          spent_txo_sum: cs.spent_txo_sum + mine.spent_txo_sum,
          tx_count: cs.tx_count + mine.tx_count,
        },
      })
    }

    if (what === 'utxo') {
      const up = this.upstream.configured ? await this.upstream.json<any[]>(upstreamBase + '/utxo') : []
      const mine = (scriptHex ? l.unspentFor(scriptHex) : []).map((o) => {
        const rec = l.txs.get(o.txid)!
        return { txid: o.txid, vout: o.vout, status: esploraStatus(l, rec.stored.height, rec.stored.time), value: Number(o.value) }
      })
      const real = up.filter((u) => !l.spent.has(`${u.txid}:${u.vout}`))
      return json([...real, ...mine])
    }

    if (what === 'txs') {
      // /txs, /txs/chain, /txs/chain/:last_seen, /txs/mempool
      if (c === 'mempool') return json([])
      const lastSeen = c === 'chain' ? d : undefined
      const mineAll = scriptHex ? l.txsFor(scriptHex) : []
      let mine = mineAll
      let upstreamPath = upstreamBase + '/txs'
      if (lastSeen) {
        const at = mineAll.findIndex((t) => t.stored.txid === lastSeen)
        if (at >= 0) mine = mineAll.slice(at + 1)
        else {
          mine = [] // paging is already inside the real chain's history
          upstreamPath += `/chain/${lastSeen}`
        }
      }
      const up = this.upstream.configured ? await this.upstream.json<any[]>(upstreamPath) : []
      return json([...mine.map((r) => esploraTx(l, r, net)), ...up])
    }
    return text('not found', 404)
  }

  /** Pass an unknown-to-the-sandbox read through to the real chain's Esplora. */
  private async proxy(path: string): Promise<Response> {
    if (!this.upstream.configured) return text('not found', 404)
    try {
      const r = await this.upstream.raw(path)
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.contentType } })
    } catch (e) {
      return this.upstreamFailure(e)
    }
  }

  private upstreamFailure(e: unknown): Response {
    if (e instanceof EsploraHttpError) return text(e.body || `upstream HTTP ${e.status}`, e.status)
    return text('upstream unavailable: ' + errMsg(e), 502)
  }

  // --- discovery / landing -----------------------------------------------------

  private discovery(l: Ledger, baseURL: string) {
    const tip = l.tip()
    return {
      fakereum: true,
      kind: 'btc',
      network: this.cfg.network.name,
      esplora: baseURL + '/api',
      rpc: baseURL + '/rpc',
      forked: this.upstream.configured,
      forkHeight: l.anchor.height,
      forkHash: l.anchor.hash,
      tip: { height: tip.height, hash: tip.hash, time: tip.time },
      faucetMaxSats: this.cfg.faucetMaxSats.toString(),
      replayGuard: 'only outputs created inside the sandbox are spendable',
    }
  }

  private landing(l: Ledger, baseURL: string): Response {
    const tip = l.tip()
    const net = this.cfg.network.name
    // Throwaway example address (all-zero key hash) in the sandbox's own network.
    const sample = scriptToAddress(concat(Uint8Array.of(0x00, 0x14), new Uint8Array(20)), this.cfg.network) ?? ''
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fakereum BTC</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c}code,pre{font:13px ui-monospace,monospace;background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}pre{padding:.7rem;overflow:auto}@media(prefers-color-scheme:dark){body{background:#151515;color:#e6e6e6}code,pre{background:#262626}}</style>
<h1>Fakereum BTC</h1>
<p>A Bitcoin sandbox on <b>${esc(net)}</b>${this.upstream.configured ? `, forked from block ${l.anchor.height}` : ' (standalone chain)'}. Tip: block <b>${tip.height}</b>.
Nothing here reaches the real network.</p>
<ul>
<li>Esplora REST: <code>${esc(baseURL)}/api</code></li>
<li>JSON-RPC: <code>${esc(baseURL)}/rpc</code></li>
<li>Discovery: <code>${esc(baseURL)}/fakereum</code></li>
</ul>
<p>Mint coins to an address, then spend them with an ordinary signed transaction. Only coins minted here can be spent; real outputs on the real chain cannot.</p>
<pre>curl -s ${esc(baseURL)}/rpc -d '{"jsonrpc":"2.0","id":1,"method":"fakereum_faucet","params":["${esc(sample)}",100000000]}'</pre>`
    return html(body)
  }
}

// --- helpers ------------------------------------------------------------------

class RpcMethodNotFound extends Error {}

function zeroStats() {
  return { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 }
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function selfBaseURL(request: Request, url: URL): string {
  const first = (v: string | null) => (v ?? '').split(',')[0]!.trim()
  const scheme = first(request.headers.get('X-Forwarded-Proto')) || url.protocol.replace(':', '')
  const host = first(request.headers.get('X-Forwarded-Host')) || url.host
  return host ? `${scheme}://${host}` : ''
}
