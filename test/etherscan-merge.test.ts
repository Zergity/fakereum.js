import { describe, expect, it } from 'vitest'
import { mergeGetLogsResult, rewriteEtherscanParams } from '../src/etherscan'
import type { Hex } from '../src/lib/hex'

const NO_FILTER = { fromBlock: null, toBlock: null }
const identity = (a: Hex): Hex => a

function entry(blockNumber: string, logIndex: string, tag: string) {
  return { blockNumber, logIndex, address: tag }
}

/** What the DO now hands merge when the explorer fetch throws or is challenged. */
const UPSTREAM_DOWN = {
  status: '0',
  message: 'NOTOK',
  result: 'upstream: explorer returned non-JSON (HTTP 403, text/html; charset=UTF-8)',
}

describe('mergeGetLogsResult with a failed upstream', () => {
  it('answers with the sandbox logs instead of dropping them', () => {
    const sandbox = [entry('0x2', '0x0', 'sandbox')]
    const out = mergeGetLogsResult(UPSTREAM_DOWN, sandbox, NO_FILTER) as Record<string, unknown>
    expect(out['status']).toBe('1')
    expect(out['result']).toEqual(sandbox)
  })

  it('says the answer is partial, and why', () => {
    const out = mergeGetLogsResult(UPSTREAM_DOWN, [entry('0x2', '0x0', 'sandbox')], NO_FILTER) as {
      message: string
    }
    // OK-prefixed so Etherscan clients accept the envelope...
    expect(out.message.startsWith('OK')).toBe(true)
    // ...but the upstream failure stays visible rather than reading as complete.
    expect(out.message).toContain('sandbox only')
    expect(out.message).toContain('HTTP 403')
  })

  it('still passes the upstream error through when the sandbox has nothing', () => {
    expect(mergeGetLogsResult(UPSTREAM_DOWN, [], NO_FILTER)).toBe(UPSTREAM_DOWN)
  })

  it('returns sandbox logs in chronological order', () => {
    const out = mergeGetLogsResult(
      UPSTREAM_DOWN,
      [entry('0x5', '0x1', 'c'), entry('0x2', '0x9', 'a'), entry('0x5', '0x0', 'b')],
      NO_FILTER,
    ) as { result: Array<Record<string, unknown>> }
    expect(out.result.map((e) => e['address'])).toEqual(['a', 'b', 'c'])
  })

  it('caps a long upstream message rather than echoing a whole error page', () => {
    const out = mergeGetLogsResult(
      { status: '0', message: 'NOTOK', result: 'x'.repeat(5000) },
      [entry('0x2', '0x0', 'sandbox')],
      NO_FILTER,
    ) as { message: string }
    expect(out.message.length).toBeLessThan(300)
  })
})

describe('mergeGetLogsResult with a healthy upstream (unchanged)', () => {
  it('interleaves sandbox records into the upstream result', () => {
    const upstream = { status: '1', message: 'OK', result: [entry('0x1', '0x0', 'up')] }
    const out = mergeGetLogsResult(upstream, [entry('0x3', '0x0', 'sandbox')], NO_FILTER) as {
      status: string
      result: Array<Record<string, unknown>>
    }
    expect(out.status).toBe('1')
    expect(out.result.map((e) => e['address'])).toEqual(['up', 'sandbox'])
  })

  it('drops upstream entries outside the requested block range', () => {
    const upstream = {
      status: '1',
      message: 'OK',
      result: [entry('0x1', '0x0', 'too-early'), entry('0x9', '0x0', 'in-range')],
    }
    const out = mergeGetLogsResult(upstream, [], { fromBlock: 5n, toBlock: null }) as {
      result: Array<Record<string, unknown>>
    }
    expect(out.result.map((e) => e['address'])).toEqual(['in-range'])
  })

  it('reports "No records found" when neither side has anything', () => {
    const upstream = { status: '1', message: 'OK', result: [] }
    expect(mergeGetLogsResult(upstream, [], NO_FILTER)).toEqual({
      status: '0',
      message: 'No records found',
      result: [],
    })
  })
})

describe('rewriteEtherscanParams chain param and key injection', () => {
  const base = 'module=logs&action=getLogs&fromBlock=1&toBlock=2'

  it('names the chain chainid by default (Etherscan v2)', () => {
    const out = rewriteEtherscanParams(new URLSearchParams(base), {
      upstreamChainId: 4663n,
      swap: identity,
    })
    expect(out.get('chainid')).toBe('4663')
    expect(out.get('chain_id')).toBeNull()
  })

  it("names it chain_id for Blockscout's multichain gateway", () => {
    const out = rewriteEtherscanParams(new URLSearchParams(base), {
      upstreamChainId: 4663n,
      swap: identity,
      chainParam: 'chain_id',
    })
    expect(out.get('chain_id')).toBe('4663')
    expect(out.get('chainid')).toBeNull()
  })

  it('injects the configured key, but never over one the caller supplied', () => {
    const injected = rewriteEtherscanParams(new URLSearchParams(base), {
      upstreamChainId: 4663n,
      swap: identity,
      apiKey: 'proapi_server',
    })
    expect(injected.get('apikey')).toBe('proapi_server')

    const callers = rewriteEtherscanParams(new URLSearchParams(base + '&apikey=proapi_caller'), {
      upstreamChainId: 4663n,
      swap: identity,
      apiKey: 'proapi_server',
    })
    expect(callers.get('apikey')).toBe('proapi_caller')
  })
})
