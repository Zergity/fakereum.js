import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverEIP712Signer, setCodeDigest } from '../src/lib/eip712'
import { rpcSetCode } from '../src/impersonate/admin_rpc'
import { Overlay } from '../src/overlay'
import { addrKey, bytesToHex, checksumAddress, hexToBytes, toAddress, type Hex } from '../src/lib/hex'
import type { Config } from '../src/types'
import type { RpcRequest } from '../src/rpc'

// A well-known throwaway key (hardhat account #1); never funded on any real chain.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const account = privateKeyToAccount(PK)
const CHAIN_ID = 42161n
const TARGET = toAddress('0x' + 'ab'.repeat(20))

// Sign the SetCode typed message the way a browser wallet would. If our
// hand-built setCodeDigest disagrees with viem's EIP-712 hashing (i.e. the
// wallet's), recovery below yields the wrong address and the test fails.
function signSetCode(code: Hex, signer = account) {
  return signer.signTypedData({
    domain: { name: 'fakereum-impersonate', version: '1', chainId: Number(CHAIN_ID) },
    types: { SetCode: [{ name: 'account', type: 'address' }, { name: 'code', type: 'bytes' }] },
    primaryType: 'SetCode',
    message: { account: TARGET, code },
  })
}

function setCodeReq(code: Hex, signature: Hex): RpcRequest {
  return { jsonrpc: '2.0', id: 1, method: 'fakereum_setCode', params: [{ account: TARGET, code, signature }] }
}

describe('setCodeDigest', () => {
  it('matches a wallet EIP-712 signature (recovers the signer)', async () => {
    const code = hexToBytes('0x60806040')
    const sig = (await signSetCode('0x60806040')) as Hex
    const recovered = await recoverEIP712Signer(setCodeDigest(CHAIN_ID, TARGET, code), sig)
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('binds to the code — a signature over different bytes does not verify to it', async () => {
    const sig = (await signSetCode('0x60806040')) as Hex
    const recovered = await recoverEIP712Signer(setCodeDigest(CHAIN_ID, TARGET, hexToBytes('0xdead')), sig)
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })
})

describe('rpcSetCode', () => {
  const adminCfg = { admins: [account.address as Hex], chainId: CHAIN_ID } as unknown as Config

  it('applies the override for an admin signer', async () => {
    const sig = (await signSetCode('0x60806040')) as Hex
    let stored: { account: Hex; code: Uint8Array } | null = null
    const resp = await rpcSetCode(setCodeReq('0x60806040', sig), adminCfg, async (a, c) => {
      stored = { account: a, code: c }
    })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ account: checksumAddress(TARGET), codeSize: 4 })
    expect(stored).not.toBeNull()
    expect(bytesToHex(stored!.code)).toBe('0x60806040')
  })

  it('accepts empty code (strip) and reports codeSize 0', async () => {
    const sig = (await signSetCode('0x')) as Hex
    let stored: Uint8Array | null = null
    const resp = await rpcSetCode(setCodeReq('0x', sig), adminCfg, async (_a, c) => {
      stored = c
    })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toMatchObject({ codeSize: 0 })
    expect(stored!.length).toBe(0)
  })

  it('rejects a non-admin signer without mutating', async () => {
    const sig = (await signSetCode('0x60806040')) as Hex
    const cfg = { admins: [toAddress('0x' + '11'.repeat(20))], chainId: CHAIN_ID } as unknown as Config
    let called = false
    const resp = await rpcSetCode(setCodeReq('0x60806040', sig), cfg, async () => {
      called = true
    })
    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toMatch(/not an admin/)
    expect(called).toBe(false)
  })

  it('rejects malformed (odd-length) bytecode hex', async () => {
    const resp = await rpcSetCode(setCodeReq('0x123' as Hex, '0x' as Hex), adminCfg, async () => {})
    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toMatch(/even-length hex/)
  })

  it('is disabled when no admins are configured', async () => {
    const cfg = { admins: [], chainId: CHAIN_ID } as unknown as Config
    const resp = await rpcSetCode(setCodeReq('0x60806040', '0x' as Hex), cfg, async () => {})
    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toMatch(/no admins configured/)
  })
})

describe('Overlay.setCode', () => {
  it('sets code and round-trips through serialize', () => {
    const ov = new Overlay()
    const delta = ov.setCode(TARGET, hexToBytes('0x1234'))
    const key = addrKey(TARGET)
    expect([...delta.updated]).toEqual([key])
    expect(ov.serialize(key)).toEqual({ code: '0x1234' })
  })

  it('preserves an existing balance/storage while replacing code', () => {
    const ov = new Overlay()
    const key = addrKey(TARGET)
    ov.load(key, { balance: '0x64', storage: { ['0x' + '00'.repeat(32)]: '0x' + '00'.repeat(31) + '07' } })
    ov.setCode(TARGET, hexToBytes('0xabcd'))
    const s = ov.serialize(key)!
    expect(s.balance).toBe('0x64')
    expect(s.code).toBe('0xabcd')
    expect(s.storage).toBeDefined()
  })

  it('emits the code override in asStateOverrides (eth_call path)', () => {
    const ov = new Overlay()
    ov.setCode(TARGET, hexToBytes('0xabcd'))
    const so = ov.asStateOverrides()
    expect(so[checksumAddress(TARGET)]!.code).toBe('0xabcd')
  })
})
