// The SDK's offline builders must produce byte-for-byte what the sandbox
// reconstructs server-side, or signatures would recover a stranger.
import { describe, expect, it } from 'vitest'
import { buildTransactionMessage, buildImportMessage, formatValue, formatData, decodeAbiString, discover } from '../src/index'
import { transactionMessage as serverTxMessage, formatMessageValue, formatMessageData } from '../../src/lib/eip191'
import { importMessage as serverImportMessage } from '../../src/import_balance'
import { importChain } from '../../src/lib/import_chains'
import { abiEncodeString, buildInfos } from '../../src/infos'
import { hexToBytes, type Hex } from '../../src/lib/hex'
import type { Config } from '../../src/types'

const NET = 'Fake Arbitrum One'
const TO = '0xab5801a7d398351b8be11c439e05c5b3259aec9b'
const ETH = 10n ** 18n

describe('buildTransactionMessage matches the server', () => {
  const cases = [
    { nonce: 0n, to: TO, value: 0n, data: '0x' },
    { nonce: 13n, to: TO, value: ETH / 1000n, data: '0x' },
    { nonce: 7n, to: TO, value: 1n, data: '0x12345678' },
    { nonce: 99n, to: TO, value: 123456789012345678901n, data: '0xa9059cbb' + 'ff'.repeat(64) },
    { nonce: 5n, to: null, value: 0n, data: '0x602a60005260206000f3' },
    { nonce: 6n, to: undefined, value: 2n * ETH, data: '0x60' },
  ]
  for (const c of cases) {
    it(`nonce ${c.nonce} to ${c.to ?? 'create'} value ${c.value} data ${c.data.slice(0, 12)}`, () => {
      const server = serverTxMessage(NET, { nonce: c.nonce, to: (c.to ?? null) as Hex | null, value: c.value, data: hexToBytes(c.data) })
      expect(buildTransactionMessage(NET, c)).toBe(server)
    })
  }

  it('accepts number / hex / decimal-string inputs', () => {
    const ref = buildTransactionMessage(NET, { nonce: 13n, to: TO, value: ETH / 1000n, data: '0x12' })
    expect(buildTransactionMessage(NET, { nonce: 13, to: TO, value: '0x38d7ea4c68000', data: '0x12' })).toBe(ref)
    expect(buildTransactionMessage(NET, { nonce: '0xd', to: TO, value: '1000000000000000', data: '0x12' })).toBe(ref)
    expect(buildTransactionMessage(NET, { nonce: '13', to: TO.toUpperCase().replace('0X', '0x'), value: ETH / 1000n, data: '0x12' })).toBe(ref)
  })

  it('formatValue / formatData agree with the server helpers', () => {
    for (const v of [0n, 1n, ETH, ETH / 1000n, ETH + 1n, 5n * ETH]) expect(formatValue(v)).toBe(formatMessageValue(v))
    for (const d of ['0x', '0x12', '0x12345678', '0x1234567890', '0x' + 'ab'.repeat(100)]) {
      expect(formatData(hexToBytes(d))).toBe(formatMessageData(hexToBytes(d)))
    }
  })
})

describe('buildImportMessage matches the server', () => {
  it('for every supported source chain', () => {
    for (const id of [1n, 42161n, 8453n, 4663n]) {
      const chain = importChain(id)!
      expect(buildImportMessage(NET, TO, chain)).toBe(serverImportMessage(NET, TO as Hex, chain))
      expect(buildImportMessage(NET, TO, { name: chain.name, chainId: Number(id) })).toBe(serverImportMessage(NET, TO as Hex, chain))
    }
  })
})

describe('discover', () => {
  const cfg = {
    chainId: 42161n,
    upstreamChainId: 42161n,
    networkName: NET,
    symbol: 'FETH',
    upstreamRpcs: ['https://arbitrum-one-rpc.publicnode.com'],
  } as unknown as Config
  const infos = buildInfos(cfg, 'https://fakereum-42161.derion.io')
  const encoded = abiEncodeString(new TextEncoder().encode(JSON.stringify(infos)))

  it('decodes the sentinel answer the server encodes', async () => {
    expect(JSON.parse(decodeAbiString(encoded))).toEqual(infos)
    const calls: unknown[] = []
    const provider = { request: async (a: unknown) => (calls.push(a), encoded) }
    expect(await discover(provider)).toEqual(infos)
    expect(calls).toEqual([{ method: 'eth_call', params: [{ to: '0x000000000000000000000000000000000000fa4e' }, 'latest'] }])
  })

  it('answers null for a real chain (empty result or revert)', async () => {
    expect(await discover({ request: async () => '0x' })).toBeNull()
    expect(
      await discover({
        request: async () => {
          throw new Error('execution reverted')
        },
      }),
    ).toBeNull()
  })
})
