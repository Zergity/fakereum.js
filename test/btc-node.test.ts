import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBtcConfig } from '../src/btc/config'
import { EsploraUpstream } from '../src/btc/esplora'
import { BtcNode, type BtcStorage } from '../src/btc/node'
import type { Ledger } from '../src/btc/ledger'
import type { Env } from '../src/types'
import { bytesToHex } from '../src/btc/bytes'
import { alice, bob, spend } from './btc-helpers'

const T0 = 1_800_000_000

class MemStorage implements BtcStorage {
  readonly data = new Map<string, unknown>()
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put(entries: Record<string, unknown>) {
    // Durable Object storage refuses a put() of more than 128 keys.
    if (Object.keys(entries).length > 128) throw new Error('put() takes at most 128 keys')
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v))
  }
  async list<T>(prefix: string) {
    return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) as Map<string, T>
  }
}

function makeNode(storage = new MemStorage(), vars: Partial<Env> = {}, clock = { now: T0 }) {
  const cfg = loadBtcConfig(vars as Env)
  const node = new BtcNode(storage, cfg, new EsploraUpstream(cfg.upstreamEsplora, 1000), () => clock.now)
  return { node, storage, clock }
}

const BASE = 'https://sandbox.test'
const get = (n: BtcNode, path: string) => n.handle(new Request(BASE + path))
const post = (n: BtcNode, path: string, body: string) => n.handle(new Request(BASE + path, { method: 'POST', body }))
const rpc = async (n: BtcNode, method: string, params: unknown[] = []) =>
  (await (await post(n, '/rpc', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))).json()) as {
    result?: any
    error?: { code: number; message: string }
  }

/** Stand-in ledger for the signer: it only needs the value of each output it spends. */
const prevouts = (entries: Record<string, bigint>) =>
  ({ outputs: new Map(Object.entries(entries).map(([k, value]) => [k, { value }])) }) as unknown as Ledger

afterEach(() => vi.unstubAllGlobals())

describe('standalone node', () => {
  it('mints, serves Esplora reads and accepts a signed spend', async () => {
    const { node, clock } = makeNode()
    expect(await (await get(node, '/fakereum')).json()).toMatchObject({ fakereum: true, kind: 'btc', network: 'mainnet', forked: false })

    const mint = await rpc(node, 'fakereum_faucet', [alice.address, 100_000_000])
    const fundTxid = mint.result as string
    expect(fundTxid).toMatch(/^[0-9a-f]{64}$/)
    expect(await (await get(node, '/api/blocks/tip/height')).text()).toBe('1')

    const utxos = (await (await get(node, `/api/address/${alice.address}/utxo`)).json()) as any[]
    expect(utxos).toMatchObject([{ txid: fundTxid, vout: 0, value: 100_000_000, status: { confirmed: true, block_height: 1 } }])
    expect(await (await get(node, `/api/address/${alice.address}`)).json()).toMatchObject({
      chain_stats: { funded_txo_count: 1, funded_txo_sum: 100_000_000, spent_txo_count: 0, tx_count: 1 },
    })

    const tx = (await (await get(node, `/api/tx/${fundTxid}`)).json()) as any
    expect(tx.vout).toMatchObject([{ value: 100_000_000, scriptpubkey_address: alice.address, scriptpubkey_type: 'v0_p2wpkh' }])
    expect(tx.vin[0].prevout).toBeNull()
    expect(tx.status).toMatchObject({ confirmed: true, block_height: 1 })

    clock.now += 30
    const raw = spend(prevouts({ [`${fundTxid}:0`]: 100_000_000n }), alice, [`${fundTxid}:0`], [
      { value: 40_000_000n, script: bob.script },
      { value: 59_999_000n, script: alice.script },
    ])
    const sent = await post(node, '/api/tx', bytesToHex(raw))
    expect(sent.status).toBe(200)
    const spendTxid = await sent.text()

    expect(((await (await get(node, `/api/address/${bob.address}/utxo`)).json()) as any[]).map((u) => u.value)).toEqual([40_000_000])
    expect(((await (await get(node, `/api/address/${alice.address}/utxo`)).json()) as any[]).map((u) => u.value)).toEqual([59_999_000])
    expect(await (await get(node, `/api/tx/${fundTxid}/outspend/0`)).json()).toMatchObject({ spent: true, txid: spendTxid, vin: 0 })
    const spent = (await (await get(node, `/api/tx/${spendTxid}`)).json()) as any
    expect(spent.fee).toBe(1000)
    expect(spent.vin[0].prevout).toMatchObject({ value: 100_000_000, scriptpubkey_address: alice.address })
    const history = (await (await get(node, `/api/address/${alice.address}/txs`)).json()) as any[]
    expect(history.map((t) => t.txid)).toEqual([spendTxid, fundTxid])
    expect(await (await get(node, '/api/blocks/tip/height')).text()).toBe('2')
    // The scripthash flavour (what BDK-style clients call) reaches the same data.
    const sh = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', alice.script)).reverse())
    expect(((await (await get(node, `/api/scripthash/${sh}/utxo`)).json()) as any[]).length).toBe(1)
  })

  it('answers a bad broadcast like bitcoind', async () => {
    const { node } = makeNode()
    const fund = (await rpc(node, 'fakereum_faucet', [alice.address, 1_000_000])).result as string
    const raw = bytesToHex(spend(prevouts({ [`${fund}:0`]: 1_000_000n }), alice, [`${fund}:0`], [{ value: 999_000n, script: bob.script }]))
    expect((await post(node, '/api/tx', raw)).status).toBe(200)
    const again = await post(node, '/api/tx', raw)
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('txn-already-known')

    const unknown = bytesToHex(spend(prevouts({ [`${'22'.repeat(32)}:0`]: 1_000n }), alice, [`${'22'.repeat(32)}:0`], [{ value: 500n, script: bob.script }]))
    expect(await (await post(node, '/api/tx', unknown)).text()).toContain('bad-txns-inputs-missingorspent')
    expect(await (await post(node, '/api/tx', 'zz')).text()).toContain('TX decode failed')
  })

  it('speaks the bitcoind RPC subset', async () => {
    const { node } = makeNode()
    expect((await rpc(node, 'getblockchaininfo')).result).toMatchObject({ chain: 'main', blocks: 0, fakereum: true })
    expect((await rpc(node, 'estimatesmartfee', [6])).result.feerate).toBeCloseTo(0.00002)

    const fund = (await rpc(node, 'fakereum_faucet', [alice.address, 5_000_000])).result as string
    const raw = bytesToHex(spend(prevouts({ [`${fund}:0`]: 5_000_000n }), alice, [`${fund}:0`], [{ value: 4_990_000n, script: bob.script }]))
    const test = await rpc(node, 'testmempoolaccept', [[raw]])
    expect(test.result[0]).toMatchObject({ allowed: true })
    expect((await rpc(node, 'getblockcount')).result).toBe(1) // testing mined nothing

    const txid = (await rpc(node, 'sendrawtransaction', [raw])).result as string
    expect(txid).toBe(test.result[0].txid)
    const verbose = (await rpc(node, 'getrawtransaction', [txid, true])).result
    expect(verbose).toMatchObject({ txid, confirmations: 1, vout: [{ n: 0, scriptPubKey: { address: bob.address } }] })
    expect((await rpc(node, 'getrawtransaction', [txid, false])).result).toBe(raw)

    const mined = (await rpc(node, 'fakereum_mine', [3])).result as string[]
    expect(mined).toHaveLength(3)
    expect((await rpc(node, 'getblockcount')).result).toBe(5)
    expect((await rpc(node, 'getbestblockhash')).result).toBe(mined[2])
    expect((await rpc(node, 'getblock', [mined[0]])).result).toMatchObject({ height: 3, nTx: 0 })
    // Mined blocks make confirmations grow.
    expect((await rpc(node, 'getrawtransaction', [txid, true])).result.confirmations).toBe(4)

    expect((await rpc(node, 'nosuchmethod')).error).toMatchObject({ code: -32601 })
    expect((await rpc(node, 'fakereum_faucet', ['not-an-address', 1])).error).toMatchObject({ code: -8 })
    expect((await rpc(node, 'fakereum_faucet', [alice.address, 1.5])).error).toMatchObject({ code: -8 })
    expect((await rpc(node, 'fakereum_faucet', [alice.address, '99999999999999'])).error?.message).toContain('between 1 and')
    expect((await rpc(node, 'fakereum_mine', [100000])).error).toMatchObject({ code: -8 })
  })

  it('keeps its state across a restart', async () => {
    const storage = new MemStorage()
    const first = makeNode(storage).node
    const fund = (await rpc(first, 'fakereum_faucet', [alice.address, 2_000_000])).result as string
    await rpc(first, 'fakereum_mine', [200]) // more rows than one storage put() may carry

    const second = makeNode(storage, {}, { now: T0 + 999 }).node
    expect((await rpc(second, 'getblockcount')).result).toBe(201)
    expect(((await (await get(second, `/api/address/${alice.address}/utxo`)).json()) as any[])[0]).toMatchObject({ txid: fund, value: 2_000_000 })
    // A new mint after the restart cannot collide with the old one.
    const next = (await rpc(second, 'fakereum_faucet', [alice.address, 2_000_000])).result as string
    expect(next).not.toBe(fund)
  })

  it('serves CORS and rejects unknown paths', async () => {
    const { node } = makeNode()
    const pre = await node.handle(new Request(BASE + '/rpc', { method: 'OPTIONS', headers: { Origin: 'https://dapp.test' } }))
    expect(pre.status).toBe(204)
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect((await get(node, '/nope')).status).toBe(404)
    expect((await get(node, '/api/address/notanaddress/utxo')).status).toBe(400)
    expect(await (await get(node, '/')).text()).toContain('Fakereum BTC')
  })
})

describe('forked node', () => {
  const TIP_HASH = 'cd'.repeat(32)
  const REAL_UTXO = { txid: '33'.repeat(32), vout: 1, value: 777, status: { confirmed: true, block_height: 899_990 } }

  function stubUpstream() {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname.replace(/^\/api/, '')
        calls.push(path)
        const ok = (body: unknown) =>
          new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
        if (path === '/blocks/tip/height') return ok('900000')
        if (path === '/blocks/tip/hash') return ok(TIP_HASH)
        if (path === `/block/${TIP_HASH}`) return ok({ timestamp: T0 - 600 })
        if (path === `/address/${alice.address}/utxo`) return ok([REAL_UTXO])
        if (path === `/address/${alice.address}`) {
          return ok({
            address: alice.address,
            chain_stats: { funded_txo_count: 3, funded_txo_sum: 5000, spent_txo_count: 2, spent_txo_sum: 4223, tx_count: 5 },
            mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
          })
        }
        if (path === '/block-height/5') return ok('ee'.repeat(32))
        if (path === `/tx/${'44'.repeat(32)}`) return ok({ txid: '44'.repeat(32), real: true })
        return new Response('Transaction not found', { status: 404 })
      }),
    )
    return calls
  }

  const vars = { UPSTREAM_ESPLORA: 'https://esplora.test/api' } as Partial<Env>

  it('starts at the upstream tip, merges real and sandbox data, and proxies the rest', async () => {
    const calls = stubUpstream()
    const { node } = makeNode(new MemStorage(), vars)

    expect(await (await get(node, '/api/blocks/tip/height')).text()).toBe('900000')
    expect(await (await get(node, '/fakereum')).json()).toMatchObject({ forked: true, forkHeight: 900_000, forkHash: TIP_HASH })

    const fund = (await rpc(node, 'fakereum_faucet', [alice.address, 10_000])).result as string
    expect(await (await get(node, '/api/blocks/tip/height')).text()).toBe('900001')
    const utxos = (await (await get(node, `/api/address/${alice.address}/utxo`)).json()) as any[]
    expect(utxos.map((u) => [u.txid, u.value])).toEqual([[REAL_UTXO.txid, 777], [fund, 10_000]])
    expect(await (await get(node, `/api/address/${alice.address}`)).json()).toMatchObject({
      chain_stats: { funded_txo_count: 4, funded_txo_sum: 15000, spent_txo_count: 2, tx_count: 6 },
    })

    // Below the fork point and unknown txs are the real chain's business.
    expect(await (await get(node, '/api/block-height/5')).text()).toBe('ee'.repeat(32))
    expect(await (await get(node, `/api/tx/${'44'.repeat(32)}`)).json()).toMatchObject({ real: true })
    const missing = await get(node, `/api/tx/${'55'.repeat(32)}`)
    expect(missing.status).toBe(404)
    // The fork point was fetched once.
    expect(calls.filter((c) => c === '/blocks/tip/height')).toHaveLength(1)
  })

  it('will not spend a real upstream output (it would be valid on the real chain too)', async () => {
    stubUpstream()
    const { node } = makeNode(new MemStorage(), vars)
    const real = `${REAL_UTXO.txid}:${REAL_UTXO.vout}`
    const raw = bytesToHex(spend(prevouts({ [real]: 777n }), alice, [real], [{ value: 100n, script: bob.script }]))
    const r = await post(node, '/api/tx', raw)
    expect(r.status).toBe(400)
    const body = await r.text()
    expect(body).toContain('bad-txns-inputs-missingorspent')
    expect(body).toContain('real chain')
  })

  it('pins the fork point in storage and does not refetch it after a restart', async () => {
    const calls = stubUpstream()
    const storage = new MemStorage()
    await get(makeNode(storage, vars).node, '/api/blocks/tip/height')
    await get(makeNode(storage, vars).node, '/api/blocks/tip/height')
    expect(calls.filter((c) => c === '/blocks/tip/height')).toHaveLength(1)
  })

  it('reports an unreachable upstream as 502 instead of anchoring at nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const { node, storage } = makeNode(new MemStorage(), vars)
    const r = await get(node, '/api/blocks/tip/height')
    expect(r.status).toBe(502)
    expect(await r.text()).toContain('upstream unavailable')
    expect(storage.data.has('btc:anchor')).toBe(false)
  })
})
