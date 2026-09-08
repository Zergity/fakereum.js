import { describe, expect, it } from 'vitest'
import { classifyBlockTag, isHistoricalBlockTag } from '../src/lib/blocktag'
import { Sandbox } from '../src/sandbox'
import type { StoredTx } from '../src/types'

describe('classifyBlockTag', () => {
  it('treats the sandbox-tip tags (and omitted) as overlay reads', () => {
    for (const tag of [undefined, null, '', 'latest', 'pending', 'safe', 'finalized', 'LATEST']) {
      expect(classifyBlockTag(tag)).toEqual({ kind: 'overlay' })
    }
  })

  it('treats earliest as a historical read', () => {
    expect(classifyBlockTag('earliest')).toEqual({ kind: 'historical' })
  })

  it('treats a 32-byte block hash as a historical read', () => {
    expect(classifyBlockTag('0x' + 'ab'.repeat(32))).toEqual({ kind: 'historical' })
    // EIP-1898 object form.
    expect(classifyBlockTag({ blockHash: '0x' + '00'.repeat(32) })).toEqual({ kind: 'historical' })
  })

  it('parses a numeric block (hex and decimal) for a tip comparison', () => {
    expect(classifyBlockTag('0x10')).toEqual({ kind: 'number', number: 16n })
    expect(classifyBlockTag('42')).toEqual({ kind: 'number', number: 42n })
    // A 40-hex value is an address-length blob, not a 64-hex hash → numeric.
    expect(classifyBlockTag({ blockNumber: '0x1234' })).toEqual({ kind: 'number', number: 0x1234n })
  })

  it('does not mistake a numeric block for a hash unless it is exactly 32 bytes', () => {
    // 63 hex digits — one short of a hash — is still just a (large) number.
    expect(classifyBlockTag('0x' + 'a'.repeat(63))).toMatchObject({ kind: 'number' })
  })

  it('falls back to the sandbox tip for an unparseable / unexpected tag', () => {
    expect(classifyBlockTag('0xnothex')).toEqual({ kind: 'overlay' })
    expect(classifyBlockTag(123 as unknown)).toEqual({ kind: 'overlay' })
    expect(classifyBlockTag({} as unknown)).toEqual({ kind: 'overlay' })
  })
})

describe('isHistoricalBlockTag', () => {
  it('named tip tags are never historical, earliest / a hash always are', () => {
    for (const start of [undefined, 100n]) {
      for (const tag of [undefined, '', 'latest', 'pending', 'safe', 'finalized']) {
        expect(isHistoricalBlockTag(tag, start)).toBe(false)
      }
      expect(isHistoricalBlockTag('earliest', start)).toBe(true)
      expect(isHistoricalBlockTag('0x' + 'ab'.repeat(32), start)).toBe(true)
    }
  })

  it('a numeric block reads the overlay while the sandbox holds no tx — the wallet case', () => {
    // MetaMask pins reads to the block its tracker last saw; on a fast chain the
    // real tip is already past it. With no sandbox tx there is nothing that could
    // be "before the overlay", so the read must still see admin-funded balances.
    expect(isHistoricalBlockTag('0x36ac539', undefined)).toBe(false)
    expect(isHistoricalBlockTag('1', undefined)).toBe(false)
  })

  it('a numeric block is historical only when strictly below the first sandbox tx block', () => {
    expect(isHistoricalBlockTag('0x63', 100n)).toBe(true) // 99 < 100
    expect(isHistoricalBlockTag('0x64', 100n)).toBe(false) // 100: the overlay's own block
    expect(isHistoricalBlockTag('0x65', 100n)).toBe(false) // a stale-tracker block after it
    expect(isHistoricalBlockTag({ blockNumber: '0x10' }, 100n)).toBe(true)
  })
})

describe('Sandbox.firstBlockNumber', () => {
  const tx = (hash: string, blockNumber: string) =>
    ({ hash, blockNumber, logs: [], seq: 0 }) as unknown as StoredTx

  it('is undefined with no stored tx and tracks the minimum as txs come and go', () => {
    const sb = new Sandbox()
    expect(sb.firstBlockNumber()).toBeUndefined()
    sb.store(tx('0x' + '01'.repeat(32), '0x200'))
    sb.store(tx('0x' + '02'.repeat(32), '0x100'))
    sb.store(tx('0x' + '03'.repeat(32), '0x300'))
    expect(sb.firstBlockNumber()).toBe(0x100n)
    sb.removeTx(('0x' + '02'.repeat(32)) as `0x${string}`)
    expect(sb.firstBlockNumber()).toBe(0x200n)
  })
})
