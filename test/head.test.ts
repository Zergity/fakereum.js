import { describe, expect, it } from 'vitest'
import { HeadTimeForwarder, headTime, isArityRejection, isHeadTag, patchHeadBlock } from '../src/head'
import type { RpcResponse } from '../src/rpc'

const NOW_MS = 1_800_000_000_000 // 2027-01-15T08:00:00Z
const NOW_SEC = 1_800_000_000n

describe('headTime', () => {
  it('is wall clock when the upstream head is behind', () => {
    expect(headTime(NOW_SEC - 49n, NOW_MS)).toBe(NOW_SEC)
    expect(headTime(0n, NOW_MS)).toBe(NOW_SEC)
    expect(headTime(undefined, NOW_MS)).toBe(NOW_SEC)
  })
  it('never moves the clock backwards past the upstream header', () => {
    expect(headTime(NOW_SEC + 3n, NOW_MS)).toBe(NOW_SEC + 3n)
  })
})

describe('isHeadTag', () => {
  it('names the head for latest / pending / omitted', () => {
    expect(isHeadTag('latest')).toBe(true)
    expect(isHeadTag('Pending')).toBe(true)
    expect(isHeadTag(undefined)).toBe(true)
  })
  it('leaves fixed blocks and finality tags alone', () => {
    expect(isHeadTag('0x10')).toBe(false)
    expect(isHeadTag('safe')).toBe(false)
    expect(isHeadTag('finalized')).toBe(false)
    expect(isHeadTag('earliest')).toBe(false)
    expect(isHeadTag({ blockNumber: '0x10' })).toBe(false)
  })
})

describe('patchHeadBlock', () => {
  it('moves a stale head timestamp to wall clock, keeping everything else', () => {
    const block = { number: '0x3b8d6c4d', hash: '0xabc', timestamp: '0x6aa75942' }
    expect(patchHeadBlock(block, NOW_MS)).toEqual({ ...block, timestamp: '0x6b49d200' })
  })
  it('keeps an upstream timestamp that is ahead of wall clock', () => {
    const block = { timestamp: '0x6b49d203' }
    expect(patchHeadBlock(block, NOW_MS)).toEqual(block)
  })
  it('passes through null / malformed results', () => {
    expect(patchHeadBlock(null, NOW_MS)).toBe(null)
    expect(patchHeadBlock({ number: '0x1' }, NOW_MS)).toEqual({ number: '0x1' })
    expect(patchHeadBlock({ timestamp: 'nope' }, NOW_MS)).toEqual({ timestamp: 'nope' })
  })
})

describe('isArityRejection', () => {
  it('matches the refusals nodes give the 4th positional', () => {
    expect(isArityRejection({ code: -32602, message: 'too many arguments, want at most 3' })).toBe(true)
    expect(
      isArityRejection({ code: -32601, message: 'Error: -32602, expect 1 required and 3 optional params for eth_call' }),
    ).toBe(true)
    expect(isArityRejection({ code: -32602, message: 'Invalid params' })).toBe(true)
  })
  it('does not match chain answers', () => {
    expect(isArityRejection({ code: 3, message: 'execution reverted' })).toBe(false)
    expect(isArityRejection({ code: -32000, message: 'gas required exceeds allowance' })).toBe(false)
    expect(isArityRejection(undefined)).toBe(false)
  })
})

function ok(result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: 1, result }
}
function err(code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id: 1, error: { code, message } }
}
const ARGS = [{ to: '0x' + 'aa'.repeat(20) }, 'latest', {}]

describe('HeadTimeForwarder', () => {
  it('appends blockOverrides.time pinned to wall clock', async () => {
    const seen: unknown[][] = []
    const fwd = new HeadTimeForwarder(
      { call: async (_m, p) => (seen.push(p), ok('0x1')) },
      () => NOW_MS,
    )
    const r = await fwd.call('eth_call', ARGS)
    expect(r.result).toBe('0x1')
    expect(seen).toEqual([[...ARGS, { time: '0x6b49d200' }]])
  })

  it('returns a real chain error without retrying', async () => {
    let calls = 0
    const fwd = new HeadTimeForwarder(
      { call: async () => (calls++, err(3, 'execution reverted')) },
      () => NOW_MS,
    )
    const r = await fwd.call('eth_call', ARGS)
    expect(r.error?.message).toBe('execution reverted')
    expect(calls).toBe(1)
  })

  it('falls back to 3 params on an arity refusal and remembers it per method', async () => {
    const seen: Array<[string, number]> = []
    let now = NOW_MS
    const fwd = new HeadTimeForwarder(
      {
        call: async (m, p) => {
          seen.push([m, p.length])
          return p.length > 3 ? err(-32602, 'too many arguments, want at most 3') : ok('0x2')
        },
      },
      () => now,
    )
    expect((await fwd.call('eth_call', ARGS)).result).toBe('0x2')
    expect(seen).toEqual([['eth_call', 4], ['eth_call', 3]])
    // Remembered: the next eth_call goes straight to 3 params...
    expect((await fwd.call('eth_call', ARGS)).result).toBe('0x2')
    expect(seen.slice(2)).toEqual([['eth_call', 3]])
    // ...but eth_estimateGas is judged on its own.
    await fwd.call('eth_estimateGas', ARGS)
    expect(seen.slice(3)).toEqual([['eth_estimateGas', 4], ['eth_estimateGas', 3]])
    // The memory expires, so a failover to a capable node picks the feature up again.
    now += 11 * 60_000
    await fwd.call('eth_call', ARGS)
    expect(seen.slice(5)[0]).toEqual(['eth_call', 4])
  })

  it('does not switch the feature off when the caller\'s own params are bad', async () => {
    const seen: number[] = []
    const fwd = new HeadTimeForwarder(
      { call: async (_m, p) => (seen.push(p.length), err(-32602, 'invalid argument 0: json: cannot unmarshal')) },
      () => NOW_MS,
    )
    const r = await fwd.call('eth_call', ARGS)
    expect(r.error?.code).toBe(-32602)
    expect(seen).toEqual([4, 3])
    // Still tries the 4-param shape next time.
    await fwd.call('eth_call', ARGS)
    expect(seen.slice(2)).toEqual([4, 3])
  })
})
