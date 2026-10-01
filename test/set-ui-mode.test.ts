import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverEIP712Signer, setUiModeDigest } from '../src/lib/eip712'
import { rpcSetUiMode } from '../src/impersonate/admin_rpc'
import type { Hex } from '../src/lib/hex'
import type { Config } from '../src/types'
import type { RpcRequest } from '../src/rpc'

// Hardhat account #1; never funded on any real chain.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const account = privateKeyToAccount(PK)
const OTHER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const CHAIN_ID = 42161n

const sign = (upstream: boolean, signer = account) =>
  signer.signTypedData({
    domain: { name: 'fakereum-impersonate', version: '1', chainId: Number(CHAIN_ID) },
    types: { SetUiMode: [{ name: 'upstream', type: 'bool' }] },
    primaryType: 'SetUiMode',
    message: { upstream },
  }) as Promise<Hex>

const req = (upstream: unknown, signature: Hex): RpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'fakereum_setUiMode',
  params: [{ upstream, signature }],
})

describe('setUiModeDigest', () => {
  it('matches a wallet EIP-712 signature', async () => {
    const recovered = await recoverEIP712Signer(setUiModeDigest(CHAIN_ID, true), await sign(true))
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('binds to the flag', async () => {
    const recovered = await recoverEIP712Signer(setUiModeDigest(CHAIN_ID, false), await sign(true))
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })
})

describe('rpcSetUiMode', () => {
  const cfg = { admins: [account.address as Hex], chainId: CHAIN_ID } as unknown as Config

  it('applies the flag for an admin signer', async () => {
    let got: boolean | null = null
    const resp = await rpcSetUiMode(req(true, await sign(true)), cfg, async (u) => {
      got = u
    })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ upstream: true })
    expect(got).toBe(true)
  })

  it('rejects a non-admin signer and does not apply', async () => {
    let called = false
    const resp = await rpcSetUiMode(req(true, await sign(true, OTHER)), cfg, async () => {
      called = true
    })
    expect(resp.error).toBeDefined()
    expect(called).toBe(false)
  })

  it('rejects a signature made for the opposite value', async () => {
    let called = false
    const resp = await rpcSetUiMode(req(false, await sign(true)), cfg, async () => {
      called = true
    })
    expect(resp.error).toBeDefined()
    expect(called).toBe(false)
  })

  it('is disabled without admins', async () => {
    const resp = await rpcSetUiMode(req(true, await sign(true)), { ...cfg, admins: [] } as Config, async () => {})
    expect(resp.error).toBeDefined()
  })

  it('requires a boolean flag', async () => {
    const resp = await rpcSetUiMode(req('true', await sign(true)), cfg, async () => {})
    expect(resp.error).toBeDefined()
  })
})
