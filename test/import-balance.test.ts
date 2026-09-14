import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  importMessage,
  importSources,
  rpcImportBalance,
  rpcImportMessage,
  rpcImportSources,
  type ImportDeps,
  type ImportRecord,
} from '../src/import_balance'
import { IMPORT_CHAINS, importChain, type ImportChain } from '../src/lib/import_chains'
import { checksumAddress, toQuantity, type Hex } from '../src/lib/hex'
import type { Config } from '../src/types'
import type { RpcRequest } from '../src/rpc'

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const ME = account.address.toLowerCase() as Hex
const OTHER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const ETH = 10n ** 18n
// An Arbitrum fork: Arbitrum is the upstream, so the other three chains are sources.
const cfg = { networkName: 'Fake Arbitrum One', upstreamChainId: 42161n, balanceMultiplier: 1000n } as unknown as Config
const MAINNET = importChain(1n)!

const req = (method: string, ...params: unknown[]): RpcRequest => ({ jsonrpc: '2.0', id: 3, method, params })

function deps(balances: Record<string, bigint>, prior?: ImportRecord) {
  const credited: Array<{ addr: Hex; credit: bigint; record: ImportRecord }> = []
  const d: ImportDeps = {
    imported: () => prior,
    credit: async (addr, credit, record) => {
      credited.push({ addr, credit, record })
      return 5n * ETH + credit
    },
    readBalance: async (chain: ImportChain) => {
      const b = balances[chain.chainId.toString()]
      if (b === undefined) throw new Error(`${chain.name} down`)
      return b
    },
    now: () => 1_700_000_000_000,
  }
  return { d, credited }
}

describe('importMessage / importSources', () => {
  it('names the sandbox, the checksummed account and the source chain', () => {
    expect(importMessage('Fake Arbitrum One', ME, MAINNET)).toBe(
      `Fakereum Import to Fake Arbitrum One\nAccount: ${checksumAddress(ME)}\nFrom: Ethereum Mainnet (chain id 1)`,
    )
  })

  it('covers mainnet, Arbitrum, Base and Robinhood, minus the sandbox upstream', () => {
    expect(IMPORT_CHAINS.map((c) => c.chainId)).toEqual([1n, 42161n, 8453n, 4663n])
    expect(importSources(cfg).map((c) => c.chainId)).toEqual([1n, 8453n, 4663n])
    expect(importSources({ ...cfg, upstreamChainId: 4663n } as Config).map((c) => c.chainId)).toEqual([1n, 42161n, 8453n])
  })
})

describe('rpcImportSources', () => {
  it('lists each source with balance and credit, per-chain errors inline, plus the import record', async () => {
    const { d } = deps({ '1': 2n * ETH, '8453': 0n })
    const resp = await rpcImportSources(req('fakereum_importSources', ME), cfg, d)
    expect(resp.result).toEqual({
      account: checksumAddress(ME),
      multiplier: '1000',
      imported: null,
      sources: [
        { chainId: '0x1', name: 'Ethereum Mainnet', symbol: 'ETH', balance: toQuantity(2n * ETH), credit: toQuantity(2000n * ETH) },
        { chainId: '0x2105', name: 'Base', symbol: 'ETH', balance: '0x0', credit: '0x0' },
        { chainId: '0x1237', name: 'Robinhood Chain', symbol: 'ETH', error: 'Robinhood Chain down' },
      ],
    })
  })

  it('rejects a bad address', async () => {
    const resp = await rpcImportSources(req('fakereum_importSources', '0x12'), cfg, deps({}).d)
    expect(resp.error?.code).toBe(-32602)
  })
})

describe('rpcImportMessage', () => {
  it('returns the text for a supported source', () => {
    const resp = rpcImportMessage(req('fakereum_importMessage', { account: ME, chainId: '0x1' }), cfg)
    expect(resp.result).toEqual({ message: importMessage(cfg.networkName, ME, MAINNET) })
    expect(rpcImportMessage(req('x', { account: ME, chainId: 8453 }), cfg).result).toBeDefined()
  })

  it('refuses the upstream chain and unknown chains', () => {
    expect(rpcImportMessage(req('x', { account: ME, chainId: 42161 }), cfg).error?.message).toMatch(/upstream.*automatically/)
    expect(rpcImportMessage(req('x', { account: ME, chainId: 10 }), cfg).error?.message).toMatch(/not an import source/)
    expect(rpcImportMessage(req('x', { account: ME }), cfg).error?.code).toBe(-32602)
  })
})

describe('rpcImportBalance', () => {
  const sign = (chain = MAINNET, who = account) => who.signMessage({ message: importMessage(cfg.networkName, ME, chain) })

  it('credits balance × multiplier once the account has signed, and records the import', async () => {
    const { d, credited } = deps({ '1': 3n * ETH })
    const signature = await sign()
    const resp = await rpcImportBalance(req('fakereum_importBalance', { account: ME, chainId: 1, signature }), cfg, d)
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({
      account: checksumAddress(ME),
      chainId: '0x1',
      chain: 'Ethereum Mainnet',
      balance: toQuantity(3n * ETH),
      credit: toQuantity(3000n * ETH),
      newBalance: toQuantity(3005n * ETH),
    })
    expect(credited).toHaveLength(1)
    expect(credited[0]).toEqual({
      addr: ME,
      credit: 3000n * ETH,
      record: { chainId: '0x1', balance: toQuantity(3n * ETH), credit: toQuantity(3000n * ETH), signature, at: 1_700_000_000_000 },
    })
  })

  it('accepts the account in any case and the chain id as decimal or hex', async () => {
    const { d, credited } = deps({ '8453': ETH })
    const base = importChain(8453n)!
    const signature = await sign(base)
    const resp = await rpcImportBalance(
      req('x', { account: account.address, chainId: '8453', signature }),
      cfg,
      d,
    )
    expect(resp.error).toBeUndefined()
    expect(credited[0]!.record.chainId).toBe('0x2105')
  })

  it('is once per account: a prior record blocks any further import, from any chain', async () => {
    const prior: ImportRecord = { chainId: '0x2105', balance: '0x1', credit: '0x3e8', signature: '0x', at: 0 }
    const { d, credited } = deps({ '1': ETH }, prior)
    const resp = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature: await sign() }), cfg, d)
    expect(resp.error?.message).toMatch(/already imported.*chain 8453.*once/)
    expect(credited).toHaveLength(0)
  })

  it('the signer must be the account', async () => {
    const { d, credited } = deps({ '1': ETH })
    const signature = await sign(MAINNET, OTHER) // OTHER signs a message about ME
    const resp = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature }), cfg, d)
    expect(resp.error?.message).toMatch(/signature is from/)
    expect(credited).toHaveLength(0)
  })

  it('the signature binds the source chain', async () => {
    const { d, credited } = deps({ '1': ETH, '8453': ETH })
    const signature = await sign(importChain(8453n)!) // signed for Base, submitted for mainnet
    const resp = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature }), cfg, d)
    expect(resp.error?.message).toMatch(/signature is from/)
    expect(credited).toHaveLength(0)
  })

  it('refuses an empty source balance without consuming the import', async () => {
    const { d, credited } = deps({ '1': 0n })
    const resp = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature: await sign() }), cfg, d)
    expect(resp.error?.message).toMatch(/nothing to import/)
    expect(credited).toHaveLength(0)
  })

  it('surfaces a source RPC failure and validates the signature shape', async () => {
    const { d } = deps({})
    const down = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature: await sign() }), cfg, d)
    expect(down.error?.message).toMatch(/Ethereum Mainnet down/)
    const bad = await rpcImportBalance(req('x', { account: ME, chainId: 1, signature: '0x1234' }), cfg, d)
    expect(bad.error?.code).toBe(-32602)
  })
})
