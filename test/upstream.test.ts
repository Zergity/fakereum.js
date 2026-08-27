import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMethodUnsupportedError, isProviderLimitError, Upstream } from '../src/upstream'

// Real refusal bodies observed from public Arbitrum endpoints.
const MEOW_UNSUPPORTED = { code: -32000, message: 'The method eth_call is not supported.' }
const ANKR_UNAUTHORIZED = {
  code: -32000,
  message: 'Unauthorized: You must authenticate your request with an API key.',
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
})
