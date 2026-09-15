import { afterEach, describe, expect, it, vi } from 'vitest'
import { headOfResponse, isMethodUnsupportedError, isProviderLimitError, Upstream } from '../src/upstream'

// Real refusal bodies observed from public Arbitrum endpoints.
const MEOW_UNSUPPORTED = { code: -32000, message: 'The method eth_call is not supported.' }
const ANKR_UNAUTHORIZED = {
  code: -32000,
  message: 'Unauthorized: You must authenticate your request with an API key.',
}
// drpc's router giving up on a call (HTTP 200 body); intermittent, not a chain answer.
const DRPC_NO_ROUTE = { code: 12, message: "Can't route your request to suitable provider" }
// publicnode's free tier, eth_getLogs without an address filter (HTTP 200 body).
const PUBLICNODE_ADDRESS_REQUIRED = {
  code: -32701,
  message:
    'Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/publicnode',
}

describe('isMethodUnsupportedError', () => {
  it('matches provider method refusals', () => {
    expect(isMethodUnsupportedError(MEOW_UNSUPPORTED)).toBe(true)
    expect(isMethodUnsupportedError({ code: -32601, message: 'whatever' })).toBe(true)
    expect(
      isMethodUnsupportedError({ code: -32000, message: 'the method eth_getProof does not exist/is not available' }),
    ).toBe(true)
    expect(isMethodUnsupportedError({ code: -32000, message: 'Method debug_traceCall is not allowed' })).toBe(true)
  })
  it('matches publicnode refusing eth_getLogs without an address filter', () => {
    expect(isMethodUnsupportedError(PUBLICNODE_ADDRESS_REQUIRED)).toBe(true)
    expect(isMethodUnsupportedError({ code: -32000, message: 'Please specify an address in your request' })).toBe(true)
    // Not a limit: that class would bench the URL for every method.
    expect(isProviderLimitError(PUBLICNODE_ADDRESS_REQUIRED)).toBe(false)
  })
  it('does not match real chain answers', () => {
    expect(isMethodUnsupportedError({ code: -32000, message: 'execution reverted' })).toBe(false)
    expect(isMethodUnsupportedError({ code: -32000, message: 'header not found' })).toBe(false)
    expect(isMethodUnsupportedError({ code: -32000, message: 'method handler crashed' })).toBe(false)
    expect(isMethodUnsupportedError(undefined)).toBe(false)
  })
})

describe('isProviderLimitError', () => {
  it('matches auth-wall refusals (ankr-style)', () => {
    expect(isProviderLimitError(ANKR_UNAUTHORIZED)).toBe(true)
  })
  it("matches drpc's routing failure by code and by message", () => {
    expect(isProviderLimitError(DRPC_NO_ROUTE)).toBe(true)
    expect(isProviderLimitError({ code: -32000, message: "Can't route your request to suitable provider" })).toBe(true)
    expect(isProviderLimitError({ code: 12, message: 'internal' })).toBe(true)
    expect(isMethodUnsupportedError(DRPC_NO_ROUTE)).toBe(false) // not a per-method refusal
  })
  it('still does not match execution errors', () => {
    expect(isProviderLimitError({ code: -32000, message: 'execution reverted' })).toBe(false)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Upstream failover', () => {
  it('fails over past a URL answering 200 + "method not supported"', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      if (url === 'https://bad') return jsonResponse({ jsonrpc: '2.0', id: 1, error: MEOW_UNSUPPORTED })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' })
    })
    const up = new Upstream(['https://bad', 'https://good'])
    const r1 = await up.call('eth_call', [{}, 'latest', {}])
    expect(r1.result).toBe('0x1')
    expect(hits).toEqual(['https://bad', 'https://good'])
    // The refusing URL is remembered per method and skipped next time.
    const r2 = await up.call('eth_call', [{}, 'latest', {}])
    expect(r2.result).toBe('0x1')
    expect(hits).toEqual(['https://bad', 'https://good', 'https://good'])
    // ...but only for that method: other methods still try it first.
    await up.call('eth_getBalance', ['0x0', 'latest'])
    expect(hits.slice(3)).toEqual(['https://bad', 'https://good'])
  })

  it('returns the refusal (not a throw) when every URL refuses the method', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: MEOW_UNSUPPORTED }),
    )
    const up = new Upstream(['https://a', 'https://b'])
    const r = await up.forward({ method: 'debug_traceCall', params: [], id: 7 })
    expect(r.error?.code).toBe(-32000)
    expect(r.error?.message).toMatch(/not supported/)
  })

  it('fails over past HTTP 401 and benches the URL', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      if (url === 'https://limited') return new Response('unauthorized', { status: 401 })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x2' })
    })
    const up = new Upstream(['https://limited', 'https://good'])
    const r1 = await up.call('eth_call', [{}, 'latest', {}])
    expect(r1.result).toBe('0x2')
    expect(hits).toEqual(['https://limited', 'https://good'])
    // benched: the 401 URL sits out the next call entirely
    await up.call('eth_call', [{}, 'latest', {}])
    expect(hits).toEqual(['https://limited', 'https://good', 'https://good'])
  })

  it('fails over past a 200 + unauthorized/api-key error body', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      if (url === 'https://ankr') return jsonResponse({ jsonrpc: '2.0', id: 1, error: ANKR_UNAUTHORIZED })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x3' })
    })
    const up = new Upstream(['https://ankr', 'https://good'])
    const r = await up.call('eth_call', [{}, 'latest', {}])
    expect(r.result).toBe('0x3')
    expect(hits).toEqual(['https://ankr', 'https://good'])
  })

  it("fails over past drpc's 200 + code 12 routing failure and benches the URL", async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      if (url === 'https://drpc') return jsonResponse({ jsonrpc: '2.0', id: 1, error: DRPC_NO_ROUTE })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x3' })
    })
    const up = new Upstream(['https://drpc', 'https://good'])
    const r = await up.call('eth_call', [{}, 'latest', {}])
    expect(r.result).toBe('0x3')
    expect(hits).toEqual(['https://drpc', 'https://good'])
    // benched: the next call skips drpc outright
    const r2 = await up.call('eth_call', [{}, 'latest', {}])
    expect(r2.result).toBe('0x3')
    expect(hits.slice(2)).toEqual(['https://good'])
  })

  it('still returns real execution errors as the answer', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })
    })
    const up = new Upstream(['https://a', 'https://b'])
    const r = await up.call('eth_call', [{}, 'latest', {}])
    expect(r.error?.message).toBe('execution reverted')
    expect(hits).toEqual(['https://a']) // no failover on a genuine chain answer
  })
  it("fails over past publicnode's address-required eth_getLogs refusal", async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      if (url === 'https://publicnode') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, error: PUBLICNODE_ADDRESS_REQUIRED })
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: [] })
    })
    const up = new Upstream(['https://publicnode', 'https://ordofi'])
    const r = await up.call('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2', topics: [] }])
    expect(r.result).toEqual([])
    expect(hits).toEqual(['https://publicnode', 'https://ordofi'])
  })
})

describe('monotonic head guard', () => {
  const HEAD = 62_471_900
  const hex = (n: number) => '0x' + n.toString(16)

  it('fails over past a head that fell behind the highest head seen, and benches the URL', async () => {
    const hits: string[] = []
    let frozen = false
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      // ordofi: fresh once, then its frozen backend (600 blocks back) answers.
      if (url === 'https://ordofi') {
        const n = frozen ? HEAD - 600 : HEAD
        frozen = true
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: hex(n) })
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: hex(HEAD + 5) })
    })
    const up = new Upstream(['https://ordofi', 'https://publicnode'])
    expect((await up.call('eth_blockNumber', [])).result).toBe(hex(HEAD))
    const r = await up.call('eth_blockNumber', [])
    expect(r.result).toBe(hex(HEAD + 5))
    expect(hits).toEqual(['https://ordofi', 'https://ordofi', 'https://publicnode'])
    // Benched: the stale URL sits out the next read entirely.
    await up.call('eth_blockNumber', [])
    expect(hits.slice(3)).toEqual(['https://publicnode'])
  })

  it('judges eth_getBlockByNumber at latest/pending by its number field', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      const n = url === 'https://stale' ? HEAD - 1000 : HEAD
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { number: hex(n), timestamp: '0x1' } })
    })
    const up = new Upstream(['https://stale', 'https://fresh'])
    up['highWater'] = BigInt(HEAD) // as if a fresh URL had answered before
    const r = await up.forward({ method: 'eth_getBlockByNumber', params: ['pending', false] })
    expect((r.result as { number: string }).number).toBe(hex(HEAD))
    expect(hits).toEqual(['https://stale', 'https://fresh'])
  })

  it('ignores honest skew within the margin and non-head reads', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: hex(HEAD - 20) })
    })
    const up = new Upstream(['https://a', 'https://b'])
    up['highWater'] = BigInt(HEAD)
    expect((await up.call('eth_blockNumber', [])).result).toBe(hex(HEAD - 20))
    expect(hits).toEqual(['https://a'])
    // A fixed-block read carries no head to judge.
    hits.length = 0
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { number: hex(HEAD - 5000) } })
    })
    await up.call('eth_getBlockByNumber', [hex(HEAD - 5000), false])
    expect(hits).toEqual(['https://a'])
  })

  it('re-anchors on the best answer when every URL is below the bound', async () => {
    const hits: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      hits.push(url)
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: hex(url === 'https://a' ? HEAD - 300 : HEAD - 200) })
    })
    const up = new Upstream(['https://a', 'https://b'])
    up['highWater'] = BigInt(HEAD + 100_000) // poisoned bound
    const r = await up.call('eth_blockNumber', [])
    expect(r.result).toBe(hex(HEAD - 200))
    expect(hits).toEqual(['https://a', 'https://b']) // one pass, no backoff retries
    expect(up['highWater']).toBe(BigInt(HEAD - 200))
  })

  it('returns the best stale head rather than nothing when the rest of the list is down', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://down') return new Response('nope', { status: 503 })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: hex(HEAD - 900) })
    })
    const up = new Upstream(['https://stale', 'https://down'])
    up['highWater'] = BigInt(HEAD)
    const r = await up.call('eth_blockNumber', [])
    expect(r.result).toBe(hex(HEAD - 900))
    expect(up['highWater']).toBe(BigInt(HEAD)) // partial pass never re-anchors
  })
})

describe('headOfResponse', () => {
  it('extracts a head only from head reads', () => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0' as const, id: 1, result })
    expect(headOfResponse('eth_blockNumber', [], ok('0x10'))).toBe(16n)
    expect(headOfResponse('eth_getBlockByNumber', ['latest', false], ok({ number: '0x10' }))).toBe(16n)
    expect(headOfResponse('eth_getBlockByNumber', ['0x10', false], ok({ number: '0x10' }))).toBeUndefined()
    expect(headOfResponse('eth_getBlockByNumber', ['safe', false], ok({ number: '0x10' }))).toBeUndefined()
    expect(headOfResponse('eth_getBlockByNumber', ['latest', false], ok(null))).toBeUndefined()
    expect(headOfResponse('eth_call', [{}, 'latest'], ok('0x10'))).toBeUndefined()
    expect(headOfResponse('eth_blockNumber', [], { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } })).toBeUndefined()
  })
})
