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
import {
  ADMIN_DEFAULT_VALIDITY_SEC,
  adminFields,
  adminMessage,
  canonAddress,
  isAdminAction,
  verifyAdmin,
  type AdminAction,
} from './admin'
import { BtcError, Ledger, type Anchor, type BlockRec, type OutRec, type Plan, type StoredTx } from './ledger'
import { signersFor, strippedTxid, txMessage, verifySigners } from './message_tx'
import { outpointKey, parseTx, type BtcTx, type TxOut } from './tx'
import { coreTx, esploraBlock, esploraStatus, esploraTx } from './render'
import { esc } from '../ui/html'
import { accountsPage, addressPage, adminPage, blockPage, dashboardPage, errorPage, txListPage, txPage, type PageCtx } from './ui'
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
  delete(keys: string[]): Promise<void>
}

const ANCHOR_KEY = 'btc:anchor'
const BLOCK_PREFIX = 'btc:block:'
const TX_PREFIX = 'btc:tx:'
const KIND_PREFIX = 'btc:kind:'
const IMPERSONATORS_KEY = 'btc:impersonators'
const UI_KEY = 'btc:ui:upstream'
const GENESIS_KEY = 'btc:genesis'
/** DO storage accepts at most 128 keys per put(). */
const PUT_CHUNK = 128
const MAX_MINE = 1000

const FEE_TARGETS = [...Array.from({ length: 25 }, (_, i) => i + 1), 144, 504, 1008]
export type AccountKind = 'upstream' | 'sandbox'
const RPC_NO_SUCH_TX = -5
const RPC_INVALID_PARAMETER = -8

export class BtcNode {
  private ledger: Ledger | null = null
  private anchoring: Promise<void> | null = null
  private readonly limiter: RateLimiter | null
  /** impersonator address -> impersonatee address. */
  private impersonators = new Map<string, string>()
  /** impersonatee script hex -> scripts allowed to sign for it. */
  private impersonatorScripts = new Map<string, Uint8Array[]>()
  private uiUpstream: boolean
  private readonly usedSignatures = new Set<string>()
  /** Account kinds fixed by a landed spend, by script hex. */
  private readonly pinnedKinds = new Map<string, AccountKind>()
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: BtcStorage,
    private readonly cfg: BtcConfig,
    private readonly upstream: EsploraUpstream,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.limiter = RateLimiter.fromConfig(cfg.rateLimitRps, cfg.rateLimitExempt)
    this.uiUpstream = cfg.uiUpstream
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

        const stored = await this.storage.get<Record<string, string>>(IMPERSONATORS_KEY)
        const pairs = stored ? Object.entries(stored) : this.cfg.impersonateSeed
        this.impersonators = new Map()
        for (const [imp, tee] of pairs) {
          const a = canonAddress(imp, this.cfg.network)
          const b = canonAddress(tee, this.cfg.network)
          if (a && b && a !== b) this.impersonators.set(a, b)
        }
        this.reindexImpersonators()
        this.uiUpstream = (await this.storage.get<boolean>(UI_KEY)) ?? this.cfg.uiUpstream
        for (const [k, v] of await this.storage.list<AccountKind>(KIND_PREFIX)) {
          this.pinnedKinds.set(k.slice(KIND_PREFIX.length), v)
        }
        this.ledger = l
        await this.applyGenesis(l)
      })().finally(() => {
        this.anchoring = null
      })
    }
    await this.anchoring
    return this.ledger!
  }

  /** Fund the configured genesis addresses once per timeline (again after a clear). */
  private async applyGenesis(l: Ledger): Promise<void> {
    if (this.cfg.genesis.length === 0 || (await this.storage.get<boolean>(GENESIS_KEY))) return
    const blocks: BlockRec[] = []
    const txs: StoredTx[] = []
    for (const g of this.cfg.genesis) {
      const script = addressToScript(g.address, this.cfg.network)
      if (!script) continue
      const r = l.faucet(script, g.sats, this.nowSec())
      blocks.push(r.block)
      txs.push(r.stored)
    }
    await this.persist(blocks, txs)
    await this.storage.put({ [GENESIS_KEY]: true })
  }

  private reindexImpersonators(): void {
    this.impersonatorScripts = new Map()
    for (const [imp, tee] of this.impersonators) {
      const impScript = addressToScript(imp, this.cfg.network)!
      const key = bytesToHex(addressToScript(tee, this.cfg.network)!)
      const list = this.impersonatorScripts.get(key)
      if (list) list.push(impScript)
      else this.impersonatorScripts.set(key, [impScript])
    }
  }

  /** Run a state-changing operation after every earlier one has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn)
    this.writes = run.catch(() => undefined)
    return run
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
      if (request.method === 'POST' && path.startsWith('/undo/')) {
        resp = await this.undoPage(l, path.slice('/undo/'.length), request)
      } else if ((request.method === 'GET' || request.method === 'HEAD') && this.isPage(path)) {
        resp = await this.page(l, url, baseURL)
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

  private decodeTx(hex: unknown): { raw: Uint8Array; tx: BtcTx } {
    let raw: Uint8Array
    try {
      raw = hexToBytes(String(hex).trim())
    } catch {
      throw new BtcError('TX decode failed: not hex', -22)
    }
    try {
      return { raw, tx: parseTx(raw) }
    } catch (e) {
      throw new BtcError('TX decode failed: ' + errMsg(e), -22)
    }
  }

  /**
   * The real outputs `tx` spends, as the sandbox sees them: unspent on the real
   * chain, and worth BALANCE_MULTIPLIER times their real value. Outputs the
   * sandbox created are not looked up.
   */
  private async resolveExternal(l: Ledger, tx: BtcTx): Promise<Map<string, OutRec>> {
    const out = new Map<string, OutRec>()
    if (!this.upstream.configured) return out
    const mult = this.cfg.balanceMultiplier
    await Promise.all(
      tx.inputs.map(async (inp) => {
        const key = outpointKey(inp.txid, inp.vout)
        if (l.outputs.has(key) || l.external.has(key) || l.spent.has(key) || out.has(key)) return
        try {
          const real = await this.upstream.json<{ vout: Array<{ value: number; scriptpubkey: string }> }>(`/tx/${inp.txid}`)
          const o = real.vout[inp.vout]
          if (!o) return
          const spent = await this.upstream.json<{ spent: boolean }>(`/tx/${inp.txid}/outspend/${inp.vout}`)
          if (spent.spent) return
          out.set(key, { txid: inp.txid, vout: inp.vout, value: BigInt(o.value) * mult, script: hexToBytes(o.scriptpubkey) })
        } catch (e) {
          if (!(e instanceof EsploraHttpError) || e.status !== 404) throw e
        }
      }),
    )
    return out
  }

  /** Prevouts of every input, in order, and which of them are real outputs. */
  private inputsOf(l: Ledger, tx: BtcTx, external: Map<string, OutRec>): { prevouts: TxOut[]; real: boolean[] } {
    const prevouts: TxOut[] = []
    const real: boolean[] = []
    for (const inp of tx.inputs) {
      const key = outpointKey(inp.txid, inp.vout)
      const own = l.outputs.get(key)
      const prev = own ?? external.get(key) ?? l.external.get(key)
      if (!prev) {
        throw new BtcError(`bad-txns-inputs-missingorspent: ${key} is neither a sandbox output nor an unspent output of the real chain`)
      }
      prevouts.push({ value: prev.value, script: prev.script })
      real.push(!own)
    }
    return { prevouts, real }
  }

  /** Whether the address has history on the real chain. */
  private async liveKind(address: string): Promise<AccountKind> {
    if (!this.upstream.configured) return 'sandbox'
    try {
      const a = await this.upstream.json<any>(`/address/${address}`)
      const n = (a.chain_stats?.tx_count ?? 0) + (a.mempool_stats?.tx_count ?? 0)
      return n > 0 ? 'upstream' : 'sandbox'
    } catch {
      return 'sandbox'
    }
  }

  /**
   * Validate and mine a transaction. The awaits (real prevouts, account kinds)
   * come first; validation and mining after them are one synchronous step, so
   * concurrent requests cannot interleave inside it.
   */
  private submit(l: Ledger, hex: string, signatures?: unknown): Promise<{ plan: Plan; blocks: BlockRec[]; txs: StoredTx[] }> {
    return this.serial(async () => {
      const { raw, tx } = this.decodeTx(hex)
      const external = await this.resolveExternal(l, tx)
      let authorized: Set<string> | undefined
      if (signatures !== undefined) {
        const { prevouts } = this.inputsOf(l, tx, external)
        authorized = verifySigners(this.cfg.network, txMessage(this.cfg.network, tx, prevouts), signatures)
      }
      // Remember which side of the replay line each spender is on, before the spend changes it.
      const toPin = new Map<string, AccountKind>()
      for (const inp of tx.inputs) {
        const prev = l.prevout(outpointKey(inp.txid, inp.vout)) ?? external.get(outpointKey(inp.txid, inp.vout))
        const addr = prev ? scriptToAddress(prev.script, this.cfg.network) : null
        const sh = prev ? bytesToHex(prev.script) : ''
        if (addr && !this.pinnedKinds.has(sh) && !toPin.has(sh)) toPin.set(sh, await this.liveKind(addr))
      }

      const plan = l.plan(raw, {
        external,
        authorized,
        impersonators: (sh) => this.impersonatorScripts.get(sh) ?? [],
      })
      const { block, stored } = l.commit(plan, this.nowSec())
      await this.persist([block], [stored])
      const pins: Record<string, AccountKind> = {}
      for (const [sh, k] of toPin) {
        this.pinnedKinds.set(sh, k)
        pins[KIND_PREFIX + sh] = k
      }
      if (Object.keys(pins).length) await this.storage.put(pins)
      return { plan, blocks: [block], txs: [stored] }
    })
  }

  private async sendRaw(l: Ledger, hex: string, signatures?: unknown): Promise<string> {
    return (await this.submit(l, hex, signatures)).plan.txid
  }

  /** fakereum_transactionMessage: what the owners of a transaction's real inputs must sign. */
  private async transactionMessage(l: Ledger, hex: unknown) {
    const { tx } = this.decodeTx(hex)
    const external = await this.resolveExternal(l, tx)
    const { prevouts, real } = this.inputsOf(l, tx, external)
    const inValue = prevouts.reduce((n, p) => n + p.value, 0n)
    const outValue = tx.outputs.reduce((n, o) => n + o.value, 0n)
    return {
      message: txMessage(this.cfg.network, tx, prevouts),
      id: strippedTxid(tx),
      signers: signersFor(this.cfg.network, prevouts, real),
      fee: (inValue - outValue).toString(),
    }
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
    return this.serial(async () => {
      const { block, stored } = l.faucet(script, sats, this.nowSec())
      await this.persist([block], [stored])
      return stored.txid
    })
  }

  private async mine(l: Ledger, n: unknown): Promise<string[]> {
    const count = n === undefined ? 1 : Number(n)
    if (!Number.isInteger(count) || count < 1 || count > MAX_MINE) {
      throw new BtcError(`block count must be between 1 and ${MAX_MINE}`, RPC_INVALID_PARAMETER)
    }
    return this.serial(async () => {
      const blocks = l.mine(count, this.nowSec())
      await this.persist(blocks, [])
      return blocks.map((b) => b.hash)
    })
  }

  // --- undo / clear / admin ---------------------------------------------------------

  /** Drop every sandbox block from `height` up, with the transactions in them. Returns the removed txids, newest first. */
  private undoFrom(l: Ledger, height: number): Promise<string[]> {
    return this.serial(async () => {
      const gone = l.blocks.filter((b) => b.height >= height)
      const keep = l.blocks.filter((b) => b.height < height)
      const goneTxids = gone.flatMap((b) => b.txids)
      const keepTxs = [...l.txs.values()].map((r) => r.stored).filter((t) => !goneTxids.includes(t.txid))
      await this.deleteKeys([
        ...gone.map((b) => BLOCK_PREFIX + String(b.height).padStart(10, '0')),
        ...goneTxids.map((id) => TX_PREFIX + id),
      ])
      this.ledger = l.rebuilt(keep, keepTxs)
      return goneTxids.reverse()
    })
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += PUT_CHUNK) await this.storage.delete(keys.slice(i, i + PUT_CHUNK))
  }

  private async clearSandbox(l: Ledger): Promise<{ blocks: number; txs: number }> {
    const removed = { blocks: l.blocks.length, txs: l.txs.size }
    await this.serial(async () => {
      await this.deleteKeys([
        ...l.blocks.map((b) => BLOCK_PREFIX + String(b.height).padStart(10, '0')),
        ...[...l.txs.keys()].map((id) => TX_PREFIX + id),
        ...[...this.pinnedKinds.keys()].map((sh) => KIND_PREFIX + sh),
        GENESIS_KEY,
      ])
      this.pinnedKinds.clear()
      const fresh = l.rebuilt([], [])
      this.ledger = fresh
      await this.applyGenesis(fresh)
    })
    return removed
  }

  private async persistImpersonators(): Promise<void> {
    await this.storage.put({ [IMPERSONATORS_KEY]: Object.fromEntries(this.impersonators) })
    this.reindexImpersonators()
  }

  private adminParams(p: unknown[]): Record<string, unknown> {
    const o = p[0]
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new BtcError('expected [{...fields, admin, signature, deadline}]', RPC_INVALID_PARAMETER)
    return o as Record<string, unknown>
  }

  /** fakereum_adminMessage [{action, ...fields}]: the text to sign for an admin action. */
  private adminMessageFor(p: unknown[]) {
    const o = this.adminParams(p)
    if (!isAdminAction(o['action'])) throw new BtcError('unknown action', RPC_INVALID_PARAMETER)
    const deadline = Number.isSafeInteger(o['deadline']) ? (o['deadline'] as number) : this.nowSec() + ADMIN_DEFAULT_VALIDITY_SEC
    return { message: adminMessage(this.cfg.network, o['action'], adminFields(this.cfg.network, o['action'], o), deadline), deadline }
  }

  private admin(action: AdminAction, p: unknown[]): { o: Record<string, unknown>; admin: string } {
    const o = this.adminParams(p)
    const admin = verifyAdmin(this.cfg.network, this.cfg.admins, action, o, this.nowSec(), this.usedSignatures)
    return { o, admin }
  }

  private listImpersonators(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [imp, tee] of this.impersonators) (out[tee] ??= []).push(imp)
    return out
  }

  /** Which side of the replay line an account is on: real-chain history, or sandbox-only. */
  private async accountKind(address: unknown) {
    const addr = canonAddress(address, this.cfg.network)
    if (!addr) throw new BtcError(`invalid ${this.cfg.network.name} address`, RPC_INVALID_PARAMETER)
    const sh = bytesToHex(addressToScript(addr, this.cfg.network)!)
    const pinned = this.pinnedKinds.get(sh)
    return { address: addr, kind: pinned ?? (await this.liveKind(addr)), pinned: pinned !== undefined, replayGuard: true }
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
      case 'fakereum_transactionMessage':
        if (typeof p[0] !== 'string') throw new BtcError('expected [unsignedTxHex]', RPC_INVALID_PARAMETER)
        return this.transactionMessage(l, p[0])
      case 'fakereum_sendTransaction': {
        // [{tx, signatures}] or [tx, signatures]; signatures = [{address, signature}] (BIP-322 simple).
        const o = p[0] && typeof p[0] === 'object' ? (p[0] as Record<string, unknown>) : { tx: p[0], signatures: p[1] }
        if (typeof o['tx'] !== 'string') throw new BtcError('expected [{tx, signatures}]', RPC_INVALID_PARAMETER)
        return this.sendRaw(l, o['tx'], o['signatures'] ?? [])
      }
      case 'fakereum_accountKind':
        return this.accountKind(p[0])
      case 'fakereum_undoLastTx': {
        const last = [...l.blocks].reverse().find((b) => b.txids.length > 0)
        if (!last) return null
        return (await this.undoFrom(l, last.height))[0] ?? null
      }
      case 'fakereum_undoBackTo': {
        const rec = typeof p[0] === 'string' ? l.txs.get(p[0].toLowerCase()) : undefined
        if (!rec) throw new BtcError(`tx ${String(p[0])} not in sandbox`, -5)
        return this.undoFrom(l, rec.stored.height)
      }
      case 'fakereum_adminMessage':
        return this.adminMessageFor(p)
      case 'fakereum_listImpersonators':
        return this.listImpersonators()
      case 'fakereum_setImpersonator': {
        const { o } = this.admin('setImpersonator', p)
        const f = adminFields(this.cfg.network, 'setImpersonator', o)
        if (f['impersonator'] === f['impersonatee']) throw new BtcError('an address cannot impersonate itself', RPC_INVALID_PARAMETER)
        this.impersonators.set(f['impersonator']!, f['impersonatee']!)
        await this.persistImpersonators()
        return true
      }
      case 'fakereum_removeImpersonator': {
        const { o } = this.admin('removeImpersonator', p)
        const f = adminFields(this.cfg.network, 'removeImpersonator', o)
        if (!this.impersonators.delete(f['impersonator']!)) throw new BtcError('no impersonation mapping for that address', -32000)
        await this.persistImpersonators()
        return true
      }
      case 'fakereum_setUiMode': {
        const { o } = this.admin('setUiMode', p)
        this.uiUpstream = o['upstream'] === true
        await this.storage.put({ [UI_KEY]: this.uiUpstream })
        return true
      }
      case 'fakereum_clearSandbox': {
        this.admin('clearSandbox', p)
        return this.clearSandbox(l)
      }
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
          if (!a || /^\d+$/.test(a)) return json(await this.blockList(l, a === undefined ? tip.height : Number(a)))
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

  /** Real-chain totals as the sandbox counts them (BALANCE_MULTIPLIER times the real sums). */
  private scaleStats<T extends { funded_txo_sum: number; spent_txo_sum: number }>(st: T): T {
    const m = Number(this.cfg.balanceMultiplier)
    return m === 1 ? st : { ...st, funded_txo_sum: st.funded_txo_sum * m, spent_txo_sum: st.spent_txo_sum * m }
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
      const cs = this.scaleStats(up.chain_stats ?? zeroStats())
      return json({
        ...up,
        mempool_stats: this.scaleStats(up.mempool_stats ?? zeroStats()),
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
      const m = Number(this.cfg.balanceMultiplier)
      const real = up.filter((u) => !l.spent.has(`${u.txid}:${u.vout}`)).map((u) => ({ ...u, value: u.value * m }))
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
      replayGuard: 'real outputs are spent with a signed message (fakereum_transactionMessage / fakereum_sendTransaction) or by an impersonator; an ordinary signature over a real output is refused',
      balanceMultiplier: this.cfg.balanceMultiplier.toString(),
      adminEnabled: this.cfg.admins.length > 0,
      uiMode: this.uiUpstream ? 'upstream' : 'sandbox',
    }
  }

  // --- explorer pages ------------------------------------------------------------

  private isPage(path: string): boolean {
    return path === '/' || /^\/(block|block-height|tx|address|search|txs|accounts|admin)(\/|$)/.test(path)
  }

  /** Up to 10 blocks, newest first, from `start` down: sandbox blocks, then the real chain below the fork. */
  private async blockList(l: Ledger, start: number): Promise<unknown[]> {
    const out: unknown[] = []
    for (let h = Math.min(start, l.tip().height); h > l.anchor.height && out.length < 10; h--) {
      out.push(esploraBlock(l, l.blockAt(h)!))
    }
    if (out.length < 10 && start >= l.anchor.height && this.upstream.configured) {
      const real = await this.upstream.json<unknown[]>(`/blocks/${Math.min(start, l.anchor.height)}`)
      out.push(...real.slice(0, 10 - out.length))
    }
    return out
  }

  /** Read an Esplora route in-process, so pages see exactly what /api serves. */
  private async data<T>(l: Ledger, path: string): Promise<T> {
    const r = await this.esplora(l, new Request('http://internal/api' + path), path)
    if (r.status !== 200) throw new PageError(r.status, await r.text())
    return (await r.json()) as T
  }

  private pageCtx(l: Ledger, baseURL: string): PageCtx {
    const tip = l.tip()
    const sample = scriptToAddress(concat(Uint8Array.of(0x00, 0x14), new Uint8Array(20)), this.cfg.network) ?? ''
    return {
      network: this.cfg.network.name,
      forked: this.upstream.configured,
      anchorHeight: l.anchor.height,
      tipHeight: tip.height,
      tipTime: tip.time,
      now: this.nowSec(),
      feeRate: this.cfg.feeRate,
      minRelayFeePerKvB: this.cfg.minRelayFeePerKvB,
      faucetMaxSats: this.cfg.faucetMaxSats.toString(),
      sampleAddress: sample,
      baseURL,
      whitelabel: this.uiUpstream,
      adminEnabled: this.cfg.admins.length > 0,
    }
  }

  private async page(l: Ledger, url: URL, baseURL: string): Promise<Response> {
    const ctx = this.pageCtx(l, baseURL)
    const [, kind, id] = url.pathname.split('/')
    try {
      if (!kind) {
        const blocks = await this.blockList(l, l.tip().height).catch(() => [])
        const txs: unknown[] = []
        for (let h = l.tip().height; h > l.anchor.height && txs.length < 10; h--) {
          for (const t of [...l.blockAt(h)!.txids].reverse()) {
            if (txs.length < 10) txs.push(esploraTx(l, l.txs.get(t)!, this.cfg.network))
          }
        }
        return html(dashboardPage(ctx, blocks.slice(0, 8), txs))
      }
      if (kind === 'txs') {
        const txs: unknown[] = []
        for (let h = l.tip().height; h > l.anchor.height && txs.length < 100; h--) {
          for (const t of [...l.blockAt(h)!.txids].reverse()) txs.push(esploraTx(l, l.txs.get(t)!, this.cfg.network))
        }
        return html(txListPage(ctx, txs))
      }
      if (kind === 'accounts' && !this.uiUpstream) return html(await this.accountsHtml(l, ctx))
      if (kind === 'admin' && !this.uiUpstream) return html(adminPage(ctx, this.cfg.admins, this.listImpersonators()))
      if (kind === 'accounts' || kind === 'admin') return html(errorPage(ctx, 404, 'No such page.'), 404)
      if (kind === 'search') return this.search(l, (url.searchParams.get('q') ?? '').trim())
      if (!id) return html(errorPage(ctx, 404, 'No such page.'), 404)
      if (kind === 'block-height') {
        const r = await this.esplora(l, new Request('http://internal/api'), `/block-height/${encodeURIComponent(id)}`)
        if (r.status !== 200) throw new PageError(r.status, await r.text())
        const h = (await r.text()).trim()
        return redirect('/block/' + h)
      }
      if (kind === 'tx') return html(txPage(ctx, await this.data(l, `/tx/${encodeURIComponent(id)}`)))
      if (kind === 'address') {
        const [info, txs] = await Promise.all([
          this.data(l, `/address/${encodeURIComponent(id)}`),
          this.data<unknown[]>(l, `/address/${encodeURIComponent(id)}/txs`),
        ])
        return html(addressPage(ctx, id, info, txs.slice(0, 25)))
      }
      if (kind === 'block') {
        const b = await this.data<any>(l, `/block/${encodeURIComponent(id)}`)
        const mine = l.blockByHash(b.id)
        const txs = mine
          ? mine.txids.slice(0, 25).map((t) => esploraTx(l, l.txs.get(t)!, this.cfg.network))
          : await this.data<unknown[]>(l, `/block/${encodeURIComponent(id)}/txs`)
        return html(blockPage(ctx, b, txs, b.tx_count ?? txs.length))
      }
      return html(errorPage(ctx, 404, 'No such page.'), 404)
    } catch (e) {
      if (e instanceof PageError) return html(errorPage(ctx, e.status, e.message.trim() || `HTTP ${e.status}`), e.status)
      return html(errorPage(ctx, 502, 'upstream unavailable: ' + errMsg(e)), 502)
    }
  }

  private async accountsHtml(l: Ledger, ctx: PageCtx): Promise<string> {
    const net = this.cfg.network
    const rows = await Promise.all(
      l.touchedScripts().map(async (sh) => {
        const address = scriptToAddress(hexToBytes(sh), net)
        if (!address) return null
        const st = l.stats(sh)
        const pinned = this.pinnedKinds.get(sh)
        return {
          address,
          balance: String(st.funded_txo_sum - st.spent_txo_sum),
          txCount: st.tx_count,
          kind: pinned ?? (await this.liveKind(address)),
          pinned: pinned !== undefined,
          impersonates: this.impersonators.get(address),
        }
      }),
    )
    return accountsPage(ctx, rows.filter((r): r is NonNullable<typeof r> => r !== null))
  }

  /** POST /undo/:txid — the explorer's undo buttons. */
  private async undoPage(l: Ledger, target: string, request: Request): Promise<Response> {
    if (this.uiUpstream) return text('not found', 404)
    const rec = l.txs.get(decodeURIComponent(target).toLowerCase())
    if (!rec) return text('undo failed: tx not in sandbox', 400)
    await this.undoFrom(l, rec.stored.height)
    const back = request.headers.get('Referer') ?? ''
    return redirect(back && !back.includes('/tx/' + target) ? back : '/txs')
  }

  /** Send a search box query to the page that fits it. */
  private async search(l: Ledger, q: string): Promise<Response> {
    if (!q) return redirect('/')
    if (/^\d+$/.test(q)) return redirect('/block-height/' + q)
    if (/^[0-9a-fA-F]{64}$/.test(q)) {
      const id = q.toLowerCase()
      if (l.txs.has(id)) return redirect('/tx/' + id)
      if (l.blockByHash(id)) return redirect('/block/' + id)
      const probe = this.upstream.configured ? await this.upstream.raw(`/tx/${id}/status`).catch(() => null) : null
      return redirect(probe?.status === 200 ? '/tx/' + id : '/block/' + id)
    }
    return redirect('/address/' + encodeURIComponent(q))
  }
}

class PageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } })
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

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function selfBaseURL(request: Request, url: URL): string {
  const first = (v: string | null) => (v ?? '').split(',')[0]!.trim()
  const scheme = first(request.headers.get('X-Forwarded-Proto')) || url.protocol.replace(':', '')
  const host = first(request.headers.get('X-Forwarded-Host')) || url.host
  return host ? `${scheme}://${host}` : ''
}
