// The sandbox shows every account without a sandbox balance as holding
// upstream × multiplier; the raw upstream read stays raw for the replay guard.
import { describe, expect, it } from 'vitest'
import { Fetcher } from '../src/fetcher'
import { Overlay } from '../src/overlay'
import { parseBalanceMultiplier } from '../src/config'
import type { Upstream } from '../src/upstream'
import { addrKey, toQuantity, type Hex } from '../src/lib/hex'

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex

function stub(balance: bigint): { up: Upstream; calls: string[] } {
  const calls: string[] = []
  const up = {
    async callResult(method: string, params: unknown[]) {
      calls.push(method + ':' + JSON.stringify(params))
      if (method === 'eth_getBalance') return toQuantity(balance)
      throw new Error('stub: ' + method)
    },
    async batch() {
      throw new Error('stub: no batch')
    },
  } as unknown as Upstream
  return { up, calls }
}

describe('parseBalanceMultiplier', () => {
  it('defaults to 1000 and accepts positive integers only', () => {
    expect(parseBalanceMultiplier(undefined)).toBe(1000n)
    expect(parseBalanceMultiplier('')).toBe(1000n)
    expect(parseBalanceMultiplier('1')).toBe(1n)
    expect(parseBalanceMultiplier('250')).toBe(250n)
    expect(parseBalanceMultiplier('0')).toBe(1000n)
    expect(parseBalanceMultiplier('-3')).toBe(1000n)
    expect(parseBalanceMultiplier('1e3')).toBe(1000n)
  })
})

describe('Fetcher balance scaling', () => {
  it('scales the cached view, leaves the raw read alone, and scales cache peeks', async () => {
    const { up, calls } = stub(7n)
    const f = new Fetcher(up, 60_000, new Map(), undefined, 1000n)
    expect(await f.getBalance(A)).toBe(7000n)
    expect(await f.getBalanceUncached(A)).toBe(7n)
    expect(await f.peekBalance(A)).toBe(7000n) // served from the cache the first read filled
    expect(await f.getBalance(A)).toBe(7000n)
    expect(calls.filter((c) => c.startsWith('eth_getBalance')).length).toBe(2) // one cached read + one uncached
  })

  it('multiplier 1 is a no-op', async () => {
    const f = new Fetcher(stub(7n).up, 0, new Map())
    expect(await f.getBalance(A)).toBe(7n)
  })
})

describe('Overlay.setBalance', () => {
  it('materializes the account and marks the balance tracked', () => {
    const o = new Overlay()
    expect(o.get(addrKey(A))).toBeUndefined()
    const delta = o.setBalance(A, 42n)
    expect([...delta.updated]).toEqual([addrKey(A)])
    expect(o.get(addrKey(A))).toMatchObject({ balance: 42n, balanceSet: true, nonceSet: false })
    o.setBalance(A, 43n)
    expect(o.get(addrKey(A))!.balance).toBe(43n)
    expect(o.serialize(addrKey(A))).toEqual({ balance: '0x2b' })
  })
})
