// Account kinds are pinned on an account's first write (its first sandbox tx)
// and never re-read after that; a read before any write reports the live
// upstream balance without pinning. The replay guard and the message-tx path
// share the store.
import { describe, expect, it } from 'vitest'
import { AccountKinds, type AccountKind } from '../src/account_kind'
import type { Hex } from '../src/lib/hex'

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Hex

function harness(balances: Record<string, bigint>) {
  const reads: string[] = []
  const stored = new Map<string, AccountKind>()
  const kinds = new AccountKinds(
    async (addr) => {
      reads.push(addr.toLowerCase())
      return balances[addr.toLowerCase()] ?? 0n
    },
    { put: async (k, kind) => void stored.set(k, kind) },
  )
  return { kinds, reads, stored, balances }
}

describe('AccountKinds', () => {
  it('pin: classifies by upstream balance on the first write and persists the verdict', async () => {
    const h = harness({ [A]: 1n })
    expect(h.kinds.peek(A)).toBeUndefined()
    expect(await h.kinds.pin(A)).toBe('upstream')
    expect(await h.kinds.pin(B)).toBe('sandbox')
    expect(h.stored.get(A)).toBe('upstream')
    expect(h.stored.get(B.toLowerCase())).toBe('sandbox')
    expect(h.kinds.peek(B)).toBe('sandbox') // case-insensitive
  })

  it('lookup: a read follows the live balance and pins nothing until the account writes', async () => {
    const h = harness({})
    expect(await h.kinds.lookup(B)).toEqual({ kind: 'sandbox', pinned: false })
    h.balances[B.toLowerCase()] = 1n
    expect(await h.kinds.lookup(B)).toEqual({ kind: 'upstream', pinned: false }) // not sticky yet
    expect(h.stored.size).toBe(0)
    expect(h.reads).toHaveLength(2)

    expect(await h.kinds.pin(B)).toBe('upstream') // first tx pins the current answer
    h.balances[B.toLowerCase()] = 0n
    expect(await h.kinds.lookup(B)).toEqual({ kind: 'upstream', pinned: true })
    expect(h.reads).toHaveLength(3) // pin read once; the pinned lookup read nothing
  })

  it('once pinned, never re-reads upstream: a later balance change does not flip the kind', async () => {
    const h = harness({})
    expect(await h.kinds.pin(B)).toBe('sandbox')
    h.balances[B.toLowerCase()] = 10n ** 18n // burner gets topped up on the real chain
    for (let i = 0; i < 5; i++) expect(await h.kinds.pin(B)).toBe('sandbox')
    expect(await h.kinds.lookup(B)).toEqual({ kind: 'sandbox', pinned: true })
    expect(h.reads).toEqual([B.toLowerCase()])

    const h2 = harness({ [A]: 5n })
    expect(await h2.kinds.pin(A)).toBe('upstream')
    h2.balances[A] = 0n // real account spends itself down
    expect(await h2.kinds.pin(A)).toBe('upstream')
    expect(h2.reads).toEqual([A])
  })

  it('pin with a probed kind stores it without another upstream read', async () => {
    const h = harness({ [A]: 1n })
    const { kind } = await h.kinds.lookup(A)
    expect(await h.kinds.pin(A, kind)).toBe('upstream')
    expect(h.stored.get(A)).toBe('upstream')
    expect(h.reads).toHaveLength(1)
    expect(await h.kinds.pin(A, 'sandbox')).toBe('upstream') // already pinned: the argument is ignored
  })

  it('shares one upstream read between concurrent first writes', async () => {
    const h = harness({ [A]: 1n })
    const [x, y, z] = await Promise.all([h.kinds.pin(A), h.kinds.pin(A), h.kinds.pin(A)])
    expect([x, y, z]).toEqual(['upstream', 'upstream', 'upstream'])
    expect(h.reads).toHaveLength(1)
  })

  it('hydrates persisted verdicts without touching upstream', async () => {
    const h = harness({ [A]: 0n })
    h.kinds.load(A, 'upstream')
    expect(await h.kinds.pin(A)).toBe('upstream')
    expect(await h.kinds.lookup(A)).toEqual({ kind: 'upstream', pinned: true })
    expect(h.reads).toEqual([])
    h.kinds.load(B.toLowerCase(), 'bogus' as AccountKind) // ignored
    expect(h.kinds.peek(B)).toBeUndefined()
  })
})
