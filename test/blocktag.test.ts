import { describe, expect, it } from 'vitest'
import { classifyBlockTag } from '../src/lib/blocktag'

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
