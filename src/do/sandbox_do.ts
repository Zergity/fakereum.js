// EvmSandbox — the stateful "node". One instance per sandbox chain id, holding
// the overlay, the sandbox tx/log store, the impersonation map, the EVM
// executor, the upstream-read cache, and the client WebSockets. The EVM runs
// HERE (Durable Objects get a 30s CPU budget on all plans, incl. Free; a plain
// Worker on Free gets 10ms). The front Worker just forwards requests in.
//
// Integrates: proxy.go (callOne routing), proxy_sandbox.go (handleSandbox),
// the explorer/admin/landing UIs, undo/clear, and ws_server.go subscriptions.

import type { Config, Env, StoredTx } from '../types'
import { loadConfig, resolveConfig, rejectUpstreamSignersEnabled } from '../config'
import {
  ERR_EXECUTION_REVERTED,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_SERVER,
  isBatch,
  makeError,
  makeResult,
  paramsArray,
  type RpcRequest,
  type RpcResponse,
} from '../rpc'
import {
  addrKey,
  bytesToHex,
  checksumAddress,
  hexToBytes,
  toAddress,
  toBigInt,
  toHash32Hex,
  toQuantity,
  type Hex,
} from '../lib/hex'
import { chainName, upstreamExplorerForChain } from '../lib/chains'
import { isHistoricalBlockTag } from '../lib/blocktag'
import { Upstream } from '../upstream'
import { Fetcher, type PersistedCode } from '../fetcher'
import { Overlay, type OverlayDelta } from '../overlay'
import { Sandbox, parseLogFilter, logMatches } from '../sandbox'
import { Executor, type CallArgs } from '../executor'
import { Impersonators } from '../impersonate/store'
import {
  rewriteImpersonatorRequest,
  rewriteImpersonatorResponseResult,
  reverseLog,
} from '../impersonate/rewrite'
import {
  rpcClearSandbox,
  rpcListImpersonators,
  rpcRemoveImpersonator,
  rpcSetCode,
  rpcSetImpersonator,
  type ClearCounts,
} from '../impersonate/admin_rpc'
import { parseStateOverrides } from '../state_override'
import { renderReceipt, renderTx, renderLog } from '../render'
import { rpcInfosCall } from '../infos'
import { corsHeaders, applyNoStore } from '../lib/cors'
import { RateLimiter } from '../lib/rate_limit'
import { newSubId, renderHead, subscriptionFrame, type WsSub } from '../subscriptions'
import {
  completeTopicOperators,
  isGetLogs,
  mergeGetLogsResult,
  rewriteEtherscanParams,
  toEtherscanLog,
  topicOrGroups,
} from '../etherscan'
import { decodeCalldata, decodeEventLog } from '../ui/decode'
import { htmlResponse } from '../ui/html'
import { renderLanding } from '../ui/landing'
import { renderTxPage } from '../ui/tx'
import { renderAddressPage } from '../ui/address'
import { renderTxList, renderAccountList } from '../ui/lists'
import { renderAdminPage } from '../ui/admin'

const BLOCKED = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sendBundle',
  'eth_sendPrivateTransaction',
  'eth_sendPrivateRawTransaction',
  'eth_cancelPrivateTransaction',
])

interface WsAttachment {
  subs: WsSub[]
  baseURL: string
}

export class EvmSandbox {
  private cfg: Config
  private upstream: Upstream
  private fetcher: Fetcher
  private overlay = new Overlay()
  private sandbox = new Sandbox()
  private impersonators = new Impersonators()
  private executor: Executor | null = null
  private limiter: RateLimiter | null
  private etherscanKeyIdx = 0
  private resolved = false
  private resolving: Promise<void> | null = null

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.cfg = loadConfig(env)
    this.upstream = new Upstream(this.cfg.upstreamRpcs)
    // Code entries persist in DO storage (not subrequest-counted, survives
    // eviction); everything else stays on the in-memory TTL cache. Upstream
    // truth, not sandbox state — deliberately untouched by fakereum_clearSandbox.
    this.fetcher = new Fetcher(this.upstream, this.cfg.cacheTtlMs, new Map(), {
      get: (addr: string) => this.ctx.storage.get<PersistedCode>('codecache:' + addr),
      put: (addr: string, entry: PersistedCode) =>
        this.ctx.storage.put('codecache:' + addr, entry),
    })
    this.limiter = RateLimiter.fromConfig(this.cfg.rateLimitRps, this.cfg.rateLimitExempt)
    // Hydrate persisted state before serving any request (re-runs on wake).
    this.ctx.blockConcurrencyWhile(async () => {
      await this.load()
    })
  }

  // --- init / persistence -------------------------------------------------

  private async load(): Promise<void> {
    const storage = this.ctx.storage
    const overlayRows = await storage.list<any>({ prefix: 'overlay:' })
    for (const [key, val] of overlayRows) this.overlay.load(key.slice('overlay:'.length), val)

    const txRows = await storage.list<StoredTx>({ prefix: 'sandbox:tx:' })
    for (const [, tx] of txRows) this.sandbox.load(tx)
    const meta = (await storage.get<{ nextSeq: number; nextLog: number }>('sandbox:meta')) ?? {
      nextSeq: 0,
      nextLog: 0,
    }
    this.sandbox.finalizeLoad(meta.nextSeq, meta.nextLog)

    const impMap = await storage.get<{ map: Record<string, string> }>('impersonators')
    this.impersonators.loadJSON(impMap?.map)
    if (this.cfg.impersonateSeed.length > 0) {
      this.impersonators.seed(this.cfg.impersonateSeed)
      await storage.put('impersonators', this.impersonators.serialize())
    }
  }

  /** Resolve chain id from upstream (once) + build the executor + genesis seed. */
  private async ensureResolved(): Promise<void> {
    if (this.resolved) return
    if (this.resolving) return this.resolving
    this.resolving = (async () => {
      const upstreamChainId = await this.fetcher.chainId()
      resolveConfig(this.cfg, upstreamChainId)
      this.executor = new Executor(this.overlay, this.fetcher, this.cfg, this.impersonators)
      // Genesis seed: fill-only, once per chain.
      if (this.cfg.genesis) {
        const applied = await this.ctx.storage.get<boolean>('meta:genesisApplied')
        if (!applied) {
          const { delta } = this.overlay.applyGenesis(this.cfg.genesis)
          await this.persistOverlay(delta)
          await this.ctx.storage.put('meta:genesisApplied', true)
        }
      }
      this.resolved = true
    })()
    try {
      await this.resolving
    } finally {
      this.resolving = null
    }
  }

  private async persistOverlay(delta: OverlayDelta): Promise<void> {
    const storage = this.ctx.storage
    for (const key of delta.updated) {
      const v = this.overlay.serialize(key)
      if (v) await storage.put('overlay:' + key, v)
      else await storage.delete('overlay:' + key)
    }
    for (const key of delta.deleted) await storage.delete('overlay:' + key)
  }

  private async persistSandboxTx(tx: StoredTx): Promise<void> {
    await this.ctx.storage.put('sandbox:tx:' + tx.hash.toLowerCase(), tx)
    await this.ctx.storage.put('sandbox:meta', this.sandbox.counters())
  }

  private async deleteSandboxTxs(hashes: Hex[]): Promise<void> {
    for (const h of hashes) await this.ctx.storage.delete('sandbox:tx:' + h.toLowerCase())
    await this.ctx.storage.put('sandbox:meta', this.sandbox.counters())
  }

  /**
   * Round-robin one of the server's configured explorer keys. Used for
   * Worker-internal limited queries (contract ABI / verified-source lookups,
   * tests) and, on a Blockscout upstream, as the fallback key for proxied /api
   * traffic — that upstream's PRO gateway serves nobody without one, and the
   * caller's own apikey still wins when supplied. An Etherscan upstream never
   * gets it: there the caller must bring their own key. Undefined when none
   * configured.
   */
  private nextEtherscanKey(): string | undefined {
    const keys = this.cfg.etherscanKeys
    if (keys.length === 0) return undefined
    const k = keys[this.etherscanKeyIdx % keys.length]
    this.etherscanKeyIdx++
    return k
  }

  // --- HTTP entry ---------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const cors = { origins: this.cfg.corsOrigins }

    // WebSocket upgrade bypasses CORS (handshake writes its own headers).
    if (isWsUpgrade(request)) return this.handleWsUpgrade(request)

    // Preflight.
    if (request.method === 'OPTIONS') {
      const h = new Headers(corsHeaders(cors, origin))
      applyNoStore(h)
      return new Response(null, { status: 204, headers: h })
    }

    // Rate limit (exact: single-threaded DO sees every request).
    if (this.limiter) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const verdict = this.limiter.check(ip)
      if (!verdict.ok) {
        return this.decorate(
          cors,
          origin,
          new Response('rate limit exceeded', {
            status: 429,
            headers: { 'Retry-After': String(verdict.retryAfter) },
          }),
        )
      }
    }

    // An exception escaping this fetch() surfaces as Cloudflare error 1101 — a
    // raw 500 that never passes through decorate(), so it carries no CORS
    // headers and browsers report an opaque CORS failure on top of the 500.
    // Everything below must therefore resolve to a Response, never throw.
    try {
      await this.ensureResolved()
    } catch (e) {
      return this.decorate(
        cors,
        origin,
        new Response('upstream unavailable: ' + String((e as Error).message ?? e), { status: 502 }),
      )
    }
    const baseURL = selfBaseURL(request, url)

    let resp: Response
    const path = url.pathname
    try {
      if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        resp = this.serveLanding()
      } else if (path === '/rpc' && request.method === 'POST') {
        resp = await this.serveRpc(request, baseURL)
      } else if (path === '/api' || path === '/v2/api') {
        resp = await this.serveEtherscan(request, url)
      } else if (path.startsWith('/tx/')) {
        resp = await this.serveTxExplorer(path.slice('/tx/'.length), baseURL)
      } else if (path.startsWith('/address/')) {
        resp = await this.serveAddressExplorer(path.slice('/address/'.length), baseURL)
      } else if (path === '/txs') {
        resp = this.serveTxList(baseURL)
      } else if (path === '/accounts') {
        resp = this.serveAccountList(baseURL)
      } else if (path.startsWith('/undo/') && request.method === 'POST') {
        resp = await this.serveUndo(path.slice('/undo/'.length), request)
      } else if (path === '/admin') {
        resp = this.serveAdmin(baseURL, origin)
      } else {
        resp = new Response('not found', { status: 404 })
      }
    } catch (e) {
      resp = new Response('internal error: ' + String((e as Error).message ?? e), { status: 500 })
    }
    return this.decorate(cors, origin, resp)
  }

  private decorate(cors: { origins: string[] }, origin: string | null, resp: Response): Response {
    const h = new Headers(resp.headers)
    for (const [k, v] of Object.entries(corsHeaders(cors, origin))) h.set(k, v)
    applyNoStore(h)
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
  }

  // --- JSON-RPC -----------------------------------------------------------

  private async serveRpc(request: Request, baseURL: string): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    if (isBatch(body)) {
      const out = await Promise.all(body.map((r) => this.callOne(r, baseURL)))
      return jsonResponse(out)
    }
    return jsonResponse(await this.callOne(body as RpcRequest, baseURL))
  }

  async callOne(req: RpcRequest, baseURL: string): Promise<RpcResponse> {
    if (!req || typeof req.method !== 'string') {
      return makeError(req?.id, ERR_INVALID_PARAMS, 'invalid request')
    }
    if (this.cfg.chainId !== 0n) {
      if (req.method === 'eth_chainId') return makeResult(req.id, '0x' + this.cfg.chainId.toString(16))
      if (req.method === 'net_version') return makeResult(req.id, this.cfg.chainId.toString())
    }
    if (BLOCKED.has(req.method)) {
      return makeError(
        req.id,
        ERR_METHOD_NOT_FOUND,
        `${req.method} is disabled in sandbox; use eth_sendRawTransaction`,
      )
    }

    const rreq = rewriteImpersonatorRequest(req, this.impersonators)

    // handleSandbox paths reach upstream fetches (forwardWithOverlayOverrides,
    // rpcGetLogs, fetcher reads) that throw on exhausted failover — surface
    // those as JSON-RPC errors so one bad request can't 500 a whole batch.
    let handled: RpcResponse | null
    try {
      handled = await this.handleSandbox(rreq, baseURL)
    } catch (e) {
      return makeError(req.id, ERR_INTERNAL, String((e as Error).message ?? e))
    }
    if (handled) {
      if (handled.result !== undefined && !handled.error) {
        handled.result = rewriteImpersonatorResponseResult(rreq.method, handled.result, this.impersonators)
      }
      return handled
    }

    // Passthrough to upstream.
    try {
      const resp = await this.upstream.forward(rreq)
      resp.jsonrpc = '2.0'
      resp.id = req.id
      if (resp.result !== undefined && !resp.error) {
        resp.result = rewriteImpersonatorResponseResult(rreq.method, resp.result, this.impersonators)
      }
      return resp
    } catch (e) {
      return makeError(req.id, ERR_INTERNAL, String((e as Error).message ?? e))
    }
  }

  /** Returns a response when fakereum handles the method, else null (passthrough). */
  private async handleSandbox(req: RpcRequest, baseURL: string): Promise<RpcResponse | null> {
    const id = req.id
    const params = paramsArray(req.params)
    switch (req.method) {
      case 'eth_sendRawTransaction':
        return this.rpcSendRawTransaction(req)
      case 'eth_call': {
        const infos = rpcInfosCall(req, this.cfg, baseURL)
        if (infos) return infos
        return this.rpcCall(req, params)
      }
      case 'eth_estimateGas':
        return this.rpcEstimateGas(req, params)
      case 'eth_getBalance':
        return this.rpcGetBalance(id, params)
      case 'eth_getTransactionCount':
        return this.rpcGetNonce(id, params)
      case 'eth_getCode':
        return this.rpcGetCode(id, params)
      case 'eth_getStorageAt':
        return this.rpcGetStorageAt(id, params)
      case 'eth_getTransactionByHash': {
        const tx = this.sandboxTx(params)
        return tx ? makeResult(id, renderTx(tx)) : null
      }
      case 'eth_getTransactionReceipt': {
        const tx = this.sandboxTx(params)
        return tx ? makeResult(id, renderReceipt(tx)) : null
      }
      case 'eth_getLogs':
        return this.rpcGetLogs(req, params)
      case 'fakereum_undoLastTx':
        return this.rpcUndoLast(id)
      case 'fakereum_undoBackTo':
        return this.rpcUndoBackTo(id, params)
      case 'fakereum_clearSandbox':
        return rpcClearSandbox(req, this.cfg, (inc, exc, keepNonce, keepBalances) =>
          this.doClear(inc, exc, keepNonce, keepBalances),
        )
      case 'fakereum_listImpersonators':
        return rpcListImpersonators(req, this.impersonators)
      case 'fakereum_setImpersonator':
        return rpcSetImpersonator(req, this.cfg, this.impersonators, () => this.persistImpersonators())
      case 'fakereum_removeImpersonator':
        return rpcRemoveImpersonator(req, this.cfg, this.impersonators, () => this.persistImpersonators())
      case 'fakereum_setCode':
        return rpcSetCode(req, this.cfg, (account, code) => this.doSetCode(account, code))
      default:
        return null
    }
  }

  private async persistImpersonators(): Promise<void> {
    await this.ctx.storage.put('impersonators', this.impersonators.serialize())
  }

  private sandboxTx(params: unknown[]): StoredTx | undefined {
    const h = params[0]
    if (typeof h !== 'string') return undefined
    return this.sandbox.get(h as Hex)
  }

  private async rpcSendRawTransaction(req: RpcRequest): Promise<RpcResponse> {
    const params = paramsArray(req.params)
    const raw = params[0]
    if (typeof raw !== 'string') return makeError(req.id, ERR_INVALID_PARAMS, 'invalid params')
    try {
      const { tx, changes } = await this.executor!.applyTx(hexToBytes(raw))
      const delta = this.overlay.commit(changes)
      this.sandbox.store(tx)
      await this.persistOverlay(delta)
      await this.persistSandboxTx(tx)
      this.notifySandboxTx(tx)
      return makeResult(req.id, tx.hash)
    } catch (e) {
      return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
    }
  }

  // --- overlay-aware reads ------------------------------------------------

  private async rpcGetBalance(id: RpcRequest['id'], params: unknown[]): Promise<RpcResponse | null> {
    const addr = asAddr(params[0])
    if (!addr) return makeError(id, ERR_INVALID_PARAMS, 'invalid address')
    if (this.isHistoricalBlock(params[1])) return null // read the real chain @ that block
    const ovl = this.overlay.get(addrKey(addr))
    const bal = ovl?.balanceSet ? ovl.balance : await this.fetcher.getBalance(addr)
    return makeResult(id, toQuantity(bal))
  }

  private async rpcGetNonce(id: RpcRequest['id'], params: unknown[]): Promise<RpcResponse | null> {
    const addr = asAddr(params[0])
    if (!addr) return makeError(id, ERR_INVALID_PARAMS, 'invalid address')
    if (this.isHistoricalBlock(params[1])) return null // read the real chain @ that block
    const ovl = this.overlay.get(addrKey(addr))
    const n = ovl?.nonceSet ? ovl.nonce : await this.fetcher.getNonce(addr)
    return makeResult(id, toQuantity(n))
  }

  private async rpcGetCode(id: RpcRequest['id'], params: unknown[]): Promise<RpcResponse | null> {
    const addr = asAddr(params[0])
    if (!addr) return makeError(id, ERR_INVALID_PARAMS, 'invalid address')
    if (this.isHistoricalBlock(params[1])) return null // read the real chain @ that block
    const ovl = this.overlay.get(addrKey(addr))
    const code = ovl?.codeSet ? ovl.code : await this.fetcher.getCode(addr)
    return makeResult(id, bytesToHex(code))
  }

  private async rpcGetStorageAt(id: RpcRequest['id'], params: unknown[]): Promise<RpcResponse | null> {
    const addr = asAddr(params[0])
    if (!addr || typeof params[1] !== 'string') return makeError(id, ERR_INVALID_PARAMS, 'invalid params')
    if (this.isHistoricalBlock(params[2])) return null // read the real chain @ that block
    const slot = toHash32Hex(params[1])
    const ovl = this.overlay.get(addrKey(addr))
    const have = ovl?.storage.get(slot)
    const v = have ?? (await this.fetcher.getStorageAt(addr, slot))
    return makeResult(id, v)
  }

  /**
   * Whether a state read at `tag` should reflect a concrete historical block on
   * the real chain (overlay off) rather than the sandbox tip. Named tags decide
   * on their own; a numeric block is historical only when it predates the first
   * sandbox tx (see isHistoricalBlockTag) — NOT when it sits below the moving
   * upstream tip, which is where every wallet read pinned by a block tracker
   * lands on a fast chain. Returning true routes the caller to the upstream
   * passthrough, which forwards the original block tag verbatim.
   */
  private isHistoricalBlock(tag: unknown): boolean {
    return isHistoricalBlockTag(tag, this.sandbox.firstBlockNumber())
  }

  // --- eth_call / eth_estimateGas ----------------------------------------

  private async rpcCall(req: RpcRequest, params: unknown[]): Promise<RpcResponse | null> {
    if (this.isHistoricalBlock(params[1])) return null // historical read → upstream, overlay off
    if (this.cfg.ethCallStorageMode === 'stateOverride') {
      return this.forwardWithOverlayOverrides(req, params, 'eth_call')
    }
    const args = parseCallArgs(params[0])
    const overrides = parseStateOverrides(params[2])
    try {
      const r = await this.executor!.call(args, overrides)
      if (r.error) {
        if (r.returnData && r.returnData !== '0x') {
          return makeError(req.id, ERR_EXECUTION_REVERTED, 'execution reverted', r.returnData)
        }
        return makeError(req.id, ERR_EXECUTION_REVERTED, r.error)
      }
      return makeResult(req.id, r.returnData)
    } catch (e) {
      return makeError(req.id, ERR_EXECUTION_REVERTED, String((e as Error).message ?? e))
    }
  }

  private async rpcEstimateGas(req: RpcRequest, params: unknown[]): Promise<RpcResponse | null> {
    if (this.isHistoricalBlock(params[1])) return null // historical read → upstream, overlay off
    if (this.cfg.ethCallStorageMode === 'stateOverride') {
      return this.forwardWithOverlayOverrides(req, params, 'eth_estimateGas')
    }
    const args = parseCallArgs(params[0])
    const overrides = parseStateOverrides(params[2])
    try {
      const r = await this.executor!.call(args, overrides)
      if (r.error && r.executionGasUsed === 0n) {
        return makeError(req.id, ERR_EXECUTION_REVERTED, r.error)
      }
      const used = r.executionGasUsed + r.intrinsicGas
      const padded = used + used / 4n // geth-style 25% pad
      return makeResult(req.id, toQuantity(padded))
    } catch (e) {
      return makeError(req.id, ERR_EXECUTION_REVERTED, String((e as Error).message ?? e))
    }
  }

  /** Forward eth_call/estimateGas to upstream with the overlay as stateOverrides. */
  private async forwardWithOverlayOverrides(
    req: RpcRequest,
    params: unknown[],
    method: string,
  ): Promise<RpcResponse> {
    const merged = this.overlay.asStateOverrides() as Record<string, Record<string, unknown>>
    const caller = params[2]
    if (caller && typeof caller === 'object') {
      for (const [k, v] of Object.entries(caller as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const key = checksumAddress(toAddress(k))
        merged[key] = mergeOverride(merged[key], v as Record<string, unknown>)
      }
    }
    const resp = await this.upstream.call(method, [params[0], 'latest', merged])
    resp.jsonrpc = '2.0'
    resp.id = req.id
    return resp
  }

  // --- eth_getLogs merge --------------------------------------------------

  private async rpcGetLogs(req: RpcRequest, params: unknown[]): Promise<RpcResponse> {
    const upstream = await this.upstream.call('eth_getLogs', params)
    if (upstream.error) {
      upstream.jsonrpc = '2.0'
      upstream.id = req.id
      return upstream
    }
    const merged: unknown[] = Array.isArray(upstream.result) ? [...upstream.result] : []
    const filter = parseLogFilter(params)
    for (const l of this.sandbox.filterLogs(filter)) merged.push(renderLog(l))
    return makeResult(req.id, merged)
  }

  // --- undo / clear -------------------------------------------------------

  private async rpcUndoLast(id: RpcRequest['id']): Promise<RpcResponse> {
    const last = this.sandbox.lastEntry()
    if (!last) return makeResult(id, null)
    try {
      await this.undoEntry(last)
      return makeResult(id, last.hash)
    } catch (e) {
      return makeError(id, ERR_SERVER, String((e as Error).message ?? e))
    }
  }

  private async rpcUndoBackTo(id: RpcRequest['id'], params: unknown[]): Promise<RpcResponse> {
    const hash = params[0]
    if (typeof hash !== 'string') return makeError(id, ERR_INVALID_PARAMS, 'expected [txHash]')
    const target = this.sandbox.get(hash as Hex)
    if (!target) return makeError(id, ERR_SERVER, `tx ${hash} not in sandbox`)
    const entries = this.sandbox.entriesAtOrAfterSeq(target.seq)
    const popped: Hex[] = []
    for (const e of entries) {
      try {
        await this.undoEntry(e)
        popped.push(e.hash)
      } catch (err) {
        return makeError(id, ERR_SERVER, String((err as Error).message ?? err))
      }
    }
    return makeResult(id, popped)
  }

  private async undoEntry(tx: StoredTx): Promise<void> {
    for (const ad of Object.values(tx.diff.accounts)) {
      if (ad.selfDestructed) {
        throw new Error(
          `tx ${tx.hash}: refusing to undo selfdestruct: pre-tx storage cannot be fully restored`,
        )
      }
    }
    const delta = this.overlay.applyReverseDiff(tx.diff)
    this.sandbox.removeTx(tx.hash)
    await this.persistOverlay(delta)
    await this.deleteSandboxTxs([tx.hash])
  }

  /** Overlay code override for `account`; persisted like any overlay write. */
  private async doSetCode(account: Hex, code: Uint8Array): Promise<void> {
    const delta = this.overlay.setCode(account, code)
    await this.persistOverlay(delta)
  }

  private async doClear(
    include: Hex[],
    exclude: Hex[],
    keepNonzeroNonce: boolean,
    keepBalances: boolean,
  ): Promise<ClearCounts> {
    const inc = new Set(include.map(addrKey))
    const exc = new Set(exclude.map(addrKey))
    // Which accounts the clear is allowed to touch — include/exclude scope only.
    // What actually survives inside a touched account (balance, EOA nonce) is
    // decided by the keep flags, handled in overlay.clearAccounts.
    const inScope = (addr: Hex): boolean => {
      const k = addrKey(addr)
      if (exc.has(k)) return false
      if (inc.size > 0 && !inc.has(k)) return false
      return true
    }
    const delta = this.overlay.clearAccounts(inScope, {
      keepNonce: keepNonzeroNonce,
      keepBalances,
    })
    // Recorded sandbox txs are part of "everything of those accounts", so an
    // in-scope sender's txs go regardless of the keep flags — a retained nonce
    // is just the count for eth_getTransactionCount, decoupled from the history.
    const removed = this.sandbox.removeWhere((tx) => inScope(tx.from))
    await this.persistOverlay(delta)
    await this.deleteSandboxTxs(removed)
    return {
      overlayCleared: delta.deleted.size + delta.updated.size,
      txsCleared: removed.length,
    }
  }

  // --- Etherscan /api -----------------------------------------------------

  private async serveEtherscan(request: Request, url: URL): Promise<Response> {
    const params = new URLSearchParams(url.search)
    // On an Etherscan upstream the proxy requires the CALLER's own key and passes
    // it straight through, so public traffic never spends the operator's quota.
    // A Blockscout upstream is the other way round: a single-chain instance takes
    // no key at all, while the multichain PRO gateway REFUSES every anonymous
    // request (HTTP 402 "Proceed with API key"), so configuring one is the
    // operator electing to fund the traffic — inject the configured key there,
    // still behind a caller-supplied apikey when there is one.
    const blockscout = this.cfg.etherscanStyle === 'blockscout'
    if (!blockscout && !params.get('apikey')) {
      return jsonResponse(
        etherscanNotOk(
          'Missing apikey: supply your own Etherscan API key (apikey=…); it is passed through to the upstream explorer',
        ),
      )
    }
    const swap = (a: Hex): Hex => this.impersonators.swap(a)
    const rewritten = rewriteEtherscanParams(params, {
      upstreamChainId: this.cfg.upstreamChainId,
      swap,
      blockFormat: blockscout ? 'decimal' : 'hex',
      chainParam: blockscout ? 'chain_id' : 'chainid',
      apiKey: blockscout ? this.nextEtherscanKey() : undefined,
    })

    if (isGetLogs(rewritten)) {
      completeTopicOperators(rewritten)
      const target = this.cfg.upstreamEtherscan + '?' + rewritten.toString()
      let upstreamJson: unknown
      try {
        upstreamJson = await this.fetchExplorerJson(target)
      } catch (e) {
        // Don't bail: a transport failure or a challenge page says nothing about
        // the SANDBOX's logs, which live only here. Shape it like an upstream
        // NOTOK and let mergeGetLogsResult decide — it answers with the sandbox
        // half when there is one, and passes this through when there isn't.
        upstreamJson = etherscanNotOk('upstream: ' + String((e as Error).message ?? e))
      }
      const filter = parseLogFilter([etherscanFilterObj(params)])
      const sandboxRecords = this.sandbox.filterLogs(filter).map((l) => {
        // The real block timeStamp lives on the owning sandbox tx (blockTime),
        // not on the StoredLog; recover it by transactionHash so the getLogs
        // record carries the true block time instead of the 0x0 placeholder.
        // Deriving at render time means every already-stored log benefits — no
        // re-execution or migration.
        const tx = this.sandbox.get(l.transactionHash)
        return toEtherscanLog(this.reverseEtherscanLog(l), {
          timeStamp: tx?.blockTime,
        })
      })
      const out = mergeGetLogsResult(upstreamJson, sandboxRecords, {
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock,
      })
      return jsonResponse(this.reverseEtherscanBody(out))
    }

    // Plain passthrough (account/contract/...). chainid forced; caller's apikey
    // carried through unchanged.
    const target = this.cfg.upstreamEtherscan + '?' + rewritten.toString()
    try {
      const body = await this.fetchExplorerJson(target, request.method)
      return jsonResponse(this.reverseEtherscanBody(body))
    } catch (e) {
      return jsonResponse(etherscanNotOk('upstream: ' + String((e as Error).message ?? e)))
    }
  }

  /**
   * Fetch the upstream explorer and parse its JSON. Throws a descriptive Error
   * on transport failure, timeout, or a non-JSON body (an HTML challenge or
   * error page), naming the HTTP status and content type instead of the
   * parser's "Unexpected token '<'".
   *
   * The wait is bounded (EXPLORER_TIMEOUT_MS). A query the explorer cannot
   * serve does not fail fast: Blockscout's gateway sat on an address-less
   * full-range getLogs for 51 s before answering "Internal server error"
   * (Robinhood Chain, 2026-09), where a healthy call — 1000 logs spanning the
   * chain's whole history — returns in ~2.5 s. For getLogs that wait also
   * delays sandbox logs that were ready immediately, so cut it short and let
   * the caller answer with the half it has.
   */
  private async fetchExplorerJson(target: string, method = 'GET'): Promise<unknown> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), EXPLORER_TIMEOUT_MS)
    let r: Response
    try {
      r = await fetch(target, { method, headers: EXPLORER_HEADERS, signal: abort.signal })
    } catch (e) {
      if (abort.signal.aborted) {
        throw new Error(`explorer did not answer within ${EXPLORER_TIMEOUT_MS / 1000}s`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      const ct = r.headers.get('content-type') ?? 'no content-type'
      throw new Error(`explorer returned non-JSON (HTTP ${r.status}, ${ct})`)
    }
  }

  /** Relabel impersonatee A -> B in an Etherscan JSON body's address fields. */
  private reverseEtherscanBody(body: unknown): unknown {
    if (this.impersonators.isEmpty() || !body || typeof body !== 'object') return body
    const swapBackAny = (v: unknown): unknown => {
      if (typeof v === 'string' && v.length === 42 && v.startsWith('0x')) {
        return this.impersonators.swapBack(v as Hex)
      }
      return v
    }
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(o)) {
          out[k] = typeof val === 'string' ? swapBackAny(val) : walk(val)
        }
        return out
      }
      return v
    }
    return walk(body)
  }

  private reverseEtherscanLog(l: import('../types').StoredLog): import('../types').StoredLog {
    return reverseLog(l, this.impersonators)
  }

  // --- UI -----------------------------------------------------------------

  private serveLanding(): Response {
    return htmlResponse(
      renderLanding({
        cfg: this.cfg,
        upstreams: this.cfg.upstreamRpcs,
        upstreamName: chainName(this.cfg.upstreamChainId),
        upstreamId: this.cfg.upstreamChainId,
        replayGuard: rejectUpstreamSignersEnabled(this.cfg),
      }),
    )
  }

  private async serveTxExplorer(rawHash: string, baseURL: string): Promise<Response> {
    const hash = decodeURIComponent(rawHash)
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return new Response('bad tx hash', { status: 400 })
    const tx = this.sandbox.get(hash as Hex)
    const explorer = upstreamExplorerForChain(this.cfg.upstreamChainId)
    if (!tx) {
      // Not a sandbox tx — point at the upstream explorer.
      return Response.redirect(explorer.base + '/tx/' + hash, 302)
    }
    const decoded = tx.input && tx.input !== '0x' ? decodeCalldata([], tx.input) : null
    const decodedLogs = tx.logs.map((l) => decodeEventLog([], l.topics, l.data))
    return htmlResponse(renderTxPage({ tx, cfg: this.cfg, decoded, decodedLogs, explorer, baseURL }))
  }

  private async serveAddressExplorer(rawAddr: string, baseURL: string): Promise<Response> {
    const addr = decodeURIComponent(rawAddr)
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return new Response('bad address', { status: 400 })
    const a = toAddress(addr)
    const overlay = this.overlay.viewAccount(a)
    const upstream = {
      balance: toQuantity(await this.fetcher.getBalance(a)),
      nonce: toQuantity(await this.fetcher.getNonce(a)),
      code: bytesToHex(await this.fetcher.getCode(a)),
    }
    const txs = this.sandbox.entriesForAddress(a)
    const explorer = upstreamExplorerForChain(this.cfg.upstreamChainId)
    return htmlResponse(
      renderAddressPage({ address: a, cfg: this.cfg, overlay, upstream, txs, explorer, baseURL }),
    )
  }

  private serveTxList(baseURL: string): Response {
    const explorer = upstreamExplorerForChain(this.cfg.upstreamChainId)
    return htmlResponse(
      renderTxList({ txs: this.sandbox.allEntries(), cfg: this.cfg, explorer, baseURL }),
    )
  }

  private serveAccountList(baseURL: string): Response {
    return htmlResponse(
      renderAccountList({ accounts: this.overlay.entriesView(), cfg: this.cfg, baseURL }),
    )
  }

  private serveAdmin(baseURL: string, origin: string | null): Response {
    return htmlResponse(
      renderAdminPage({
        cfg: this.cfg,
        ctx: { baseURL, clientIp: '', origin },
        hasAdmins: this.cfg.admins.length > 0,
      }),
    )
  }

  private async serveUndo(target: string, request: Request): Promise<Response> {
    let popped: Hex[] = []
    try {
      if (target === 'last') {
        const last = this.sandbox.lastEntry()
        if (last) {
          await this.undoEntry(last)
          popped = [last.hash]
        }
      } else {
        const t = decodeURIComponent(target)
        const tx = this.sandbox.get(t as Hex)
        if (!tx) return new Response('undo failed: tx not in sandbox', { status: 400 })
        for (const e of this.sandbox.entriesAtOrAfterSeq(tx.seq)) {
          await this.undoEntry(e)
          popped.push(e.hash)
        }
      }
    } catch (e) {
      return new Response('undo failed: ' + String((e as Error).message ?? e), { status: 400 })
    }
    let dest = request.headers.get('Referer') ?? ''
    if (!dest || dest.includes('/tx/' + target)) dest = '/txs'
    return new Response(null, { status: 303, headers: { Location: dest } })
  }

  // --- WebSocket (sandbox-driven subscriptions, hibernatable) -------------

  private handleWsUpgrade(request: Request): Response {
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    const url = new URL(request.url)
    server.serializeAttachment({ subs: [], baseURL: selfBaseURL(request, url) } satisfies WsAttachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let req: RpcRequest
    try {
      req = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return
    }
    try {
      await this.ensureResolved()
    } catch (e) {
      ws.send(JSON.stringify(makeError(req.id, ERR_INTERNAL, String((e as Error).message ?? e))))
      return
    }
    const att = (ws.deserializeAttachment() as WsAttachment | null) ?? { subs: [], baseURL: '' }
    let resp: RpcResponse
    if (req.method === 'eth_subscribe') {
      resp = this.wsSubscribe(ws, att, req)
    } else if (req.method === 'eth_unsubscribe') {
      resp = this.wsUnsubscribe(ws, att, req)
    } else {
      resp = await this.callOne(req, att.baseURL)
    }
    ws.send(JSON.stringify(resp))
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }

  private wsSubscribe(ws: WebSocket, att: WsAttachment, req: RpcRequest): RpcResponse {
    const params = paramsArray(req.params)
    const kind = params[0]
    if (kind !== 'newHeads' && kind !== 'logs') {
      return makeError(req.id, ERR_METHOD_NOT_FOUND, `subscription kind ${String(kind)} not supported`)
    }
    const id = newSubId()
    let filter: WsSub['filter'] = null
    if (kind === 'logs') {
      const rawFilter = params[1] && typeof params[1] === 'object' ? (params[1] as Record<string, unknown>) : {}
      // Rewrite the filter B->A like a request, then store the (A-space) filter.
      const rw = rewriteImpersonatorRequest(
        { jsonrpc: '2.0', method: 'eth_getLogs', params: [rawFilter] },
        this.impersonators,
      )
      filter = (paramsArray(rw.params)[0] as Record<string, unknown>) ?? {}
    }
    att.subs.push({ id, kind, filter })
    ws.serializeAttachment(att)
    return makeResult(req.id, id)
  }

  private wsUnsubscribe(ws: WebSocket, att: WsAttachment, req: RpcRequest): RpcResponse {
    const params = paramsArray(req.params)
    const id = params[0]
    const before = att.subs.length
    att.subs = att.subs.filter((s) => s.id !== id)
    ws.serializeAttachment(att)
    return makeResult(req.id, att.subs.length < before)
  }

  /** Push newHeads + matching logs to subscribers after a sandbox tx. */
  private notifySandboxTx(tx: StoredTx): void {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    const head = renderHead(tx)
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WsAttachment | null
      if (!att) continue
      for (const sub of att.subs) {
        try {
          if (sub.kind === 'newHeads') {
            ws.send(subscriptionFrame(sub.id, head))
          } else {
            const f = parseLogFilter([sub.filter ?? {}])
            for (const l of tx.logs) {
              if (!logMatches(f, l)) continue
              ws.send(subscriptionFrame(sub.id, renderLog(reverseLog(l, this.impersonators))))
            }
          }
        } catch {
          /* skip a dead socket */
        }
      }
    }
  }
}

// --- module helpers -------------------------------------------------------

// Request headers for the upstream explorer. Blockscout instances sit behind a
// Cloudflare managed challenge keyed on the User-Agent: a bare Workers fetch()
// (no browser-like UA) is answered with an HTML "Just a moment..." challenge
// page instead of JSON, which used to surface here as a 502 on every proxied
// call (observed on robinhoodchain.blockscout.com, 2026-09). A desktop-browser
// UA passes the challenge; an apikey parameter alone does not. Etherscan
// proper does not care either way.
/** Upper bound on one upstream explorer call — see fetchExplorerJson. */
const EXPLORER_TIMEOUT_MS = 20_000

const EXPLORER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/**
 * Etherscan-style failure envelope. Upstream failures are reported this way
 * (HTTP 200) rather than as HTTP 502: Etherscan clients already treat
 * status "0" / NOTOK as an error, whereas on a custom domain Cloudflare
 * replaces an origin 502 body with its own bare "error code: 502", hiding the
 * diagnostic — which is exactly how the Blockscout challenge surfaced.
 */
function etherscanNotOk(result: string): { status: '0'; message: 'NOTOK'; result: string } {
  return { status: '0', message: 'NOTOK', result }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function isWsUpgrade(request: Request): boolean {
  return (
    request.method === 'GET' &&
    (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket'
  )
}

function selfBaseURL(request: Request, url: URL): string {
  let scheme = url.protocol.replace(':', '')
  if (scheme === 'ws') scheme = 'http'
  if (scheme === 'wss') scheme = 'https'
  const xfp = firstCSV(request.headers.get('X-Forwarded-Proto'))
  if (xfp) scheme = xfp
  let host = url.host
  const xfh = firstCSV(request.headers.get('X-Forwarded-Host'))
  if (xfh) host = xfh
  return host ? `${scheme}://${host}` : ''
}

function firstCSV(v: string | null): string {
  if (!v) return ''
  const i = v.indexOf(',')
  return (i >= 0 ? v.slice(0, i) : v).trim()
}

function asAddr(v: unknown): Hex | null {
  if (typeof v !== 'string') return null
  try {
    return toAddress(v)
  } catch {
    return null
  }
}

function parseCallArgs(v: unknown): CallArgs {
  const out: CallArgs = {}
  if (!v || typeof v !== 'object') return out
  const o = v as Record<string, unknown>
  if (typeof o['from'] === 'string') out.from = toAddress(o['from'])
  if (typeof o['to'] === 'string') out.to = toAddress(o['to'])
  if (typeof o['gas'] === 'string') out.gas = toBigInt(o['gas'])
  if (typeof o['gasPrice'] === 'string') out.gasPrice = toBigInt(o['gasPrice'])
  if (typeof o['value'] === 'string') out.value = toBigInt(o['value'])
  const data = o['data'] ?? o['input']
  if (typeof data === 'string') out.data = data as Hex
  return out
}

function mergeOverride(
  base: Record<string, unknown> | undefined,
  caller: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) }
  if (caller['balance'] !== undefined) out['balance'] = caller['balance']
  if (caller['nonce'] !== undefined) out['nonce'] = caller['nonce']
  if (caller['code'] !== undefined) out['code'] = caller['code']
  const cd = caller['stateDiff']
  if (cd && typeof cd === 'object') {
    const sd = { ...((out['stateDiff'] as Record<string, unknown>) ?? {}) }
    for (const [k, v] of Object.entries(cd as Record<string, unknown>)) sd[k] = v
    out['stateDiff'] = sd
  }
  if (caller['state'] !== undefined) out['state'] = caller['state']
  return out
}

function etherscanFilterObj(params: URLSearchParams): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  const from = params.get('fromBlock')
  const to = params.get('toBlock')
  const addr = params.get('address')
  if (from) obj['fromBlock'] = from
  if (to) obj['toBlock'] = to
  if (addr) obj['address'] = addr
  const topics: (string | null)[] = []
  for (let i = 0; i < 4; i++) {
    const t = params.get('topic' + i)
    topics.push(t ?? null)
  }
  if (topics.some((t) => t !== null)) {
    obj['topics'] = topics
    // Carry the topicI_J_opr=or grouping so the sandbox matcher ORs across
    // positions instead of ANDing them (the upstream request gets the same
    // grouping via completeTopicOperators).
    obj['topicGroups'] = topicOrGroups(params)
  }
  return obj
}
