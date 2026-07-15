import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { clearSandboxDigest, recoverEIP712Signer } from '../src/lib/eip712'
import { rpcClearSandbox } from '../src/impersonate/admin_rpc'
import { Overlay } from '../src/overlay'
import { addrKey, toAddress, type Hex } from '../src/lib/hex'
import type { Config } from '../src/types'
import type { RpcRequest } from '../src/rpc'

// hardhat account #1 — a throwaway key, never funded on any real chain.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const account = privateKeyToAccount(PK)
const CHAIN_ID = 42161n
const A = toAddress('0x' + 'aa'.repeat(20))
const B = toAddress('0x' + 'bb'.repeat(20))

// Sign the ClearSandbox typed message exactly as a browser wallet would. If our
// hand-built clearSandboxDigest disagrees with viem's EIP-712 hashing, recovery
// yields the wrong signer and these tests fail — which is the point.
function signClear(
  include: Hex[],
  exclude: Hex[],
  keepNonzeroNonce: boolean,
  keepBalances = false,
  signer = account,
) {
  return signer.signTypedData({
    domain: { name: 'fakereum-impersonate', version: '1', chainId: Number(CHAIN_ID) },
    types: {
      ClearSandbox: [
        { name: 'include', type: 'address[]' },
        { name: 'exclude', type: 'address[]' },
        { name: 'keepNonzeroNonce', type: 'bool' },
        { name: 'keepBalances', type: 'bool' },
      ],
    },
    primaryType: 'ClearSandbox',
    message: { include, exclude, keepNonzeroNonce, keepBalances },
  })
}

function clearReq(fields: Record<string, unknown>): RpcRequest {
  return { jsonrpc: '2.0', id: 1, method: 'fakereum_clearSandbox', params: [fields] }
}

describe('clearSandboxDigest', () => {
  it('matches a wallet EIP-712 signature over both keep flags', async () => {
    const sig = (await signClear([A], [B], true, true)) as Hex
    const recovered = await recoverEIP712Signer(
      clearSandboxDigest(CHAIN_ID, [A], [B], true, true),
      sig,
    )
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('binds to keepNonzeroNonce — a true signature does not verify against false', async () => {
    const sig = (await signClear([], [], true, false)) as Hex
    const recovered = await recoverEIP712Signer(
      clearSandboxDigest(CHAIN_ID, [], [], false, false),
      sig,
    )
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })

  it('binds to keepBalances — flipping it alone breaks recovery', async () => {
    const sig = (await signClear([], [], false, true)) as Hex
    const recovered = await recoverEIP712Signer(
      clearSandboxDigest(CHAIN_ID, [], [], false, false),
      sig,
    )
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })
})

describe('rpcClearSandbox', () => {
  const adminCfg = { admins: [account.address as Hex], chainId: CHAIN_ID } as unknown as Config

  it('passes both signed keep flags through to the clear fn', async () => {
    const sig = (await signClear([], [], true, true)) as Hex
    let seenNonce: boolean | null = null
    let seenBal: boolean | null = null
    const resp = await rpcClearSandbox(
      clearReq({ include: [], exclude: [], keepNonzeroNonce: true, keepBalances: true, signature: sig }),
      adminCfg,
      async (_i, _e, keepNonce, keepBal) => {
        seenNonce = keepNonce
        seenBal = keepBal
        return { overlayCleared: 0, txsCleared: 0 }
      },
    )
    expect(resp.error).toBeUndefined()
    expect(seenNonce).toBe(true)
    expect(seenBal).toBe(true)
  })

  it('defaults both flags to false when omitted', async () => {
    const sig = (await signClear([], [], false, false)) as Hex
    let seenNonce: boolean | null = null
    let seenBal: boolean | null = null
    const resp = await rpcClearSandbox(
      clearReq({ signature: sig }),
      adminCfg,
      async (_i, _e, keepNonce, keepBal) => {
        seenNonce = keepNonce
        seenBal = keepBal
        return { overlayCleared: 0, txsCleared: 0 }
      },
    )
    expect(resp.error).toBeUndefined()
    expect(seenNonce).toBe(false)
    expect(seenBal).toBe(false)
  })

  it('rejects (and does not clear) when a flag was tampered after signing', async () => {
    // Admin signed keepNonzeroNonce=true; a tampered request flips it to false.
    const sig = (await signClear([], [], true, false)) as Hex
    let called = false
    const resp = await rpcClearSandbox(
      clearReq({ include: [], exclude: [], keepNonzeroNonce: false, signature: sig }),
      adminCfg,
      async () => {
        called = true
        return { overlayCleared: 0, txsCleared: 0 }
      },
    )
    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toMatch(/not an admin/)
    expect(called).toBe(false)
  })

  it('is disabled when no admins are configured', async () => {
    const cfg = { admins: [], chainId: CHAIN_ID } as unknown as Config
    const resp = await rpcClearSandbox(clearReq({ signature: '0x' }), cfg, async () => ({
      overlayCleared: 0,
      txsCleared: 0,
    }))
    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toMatch(/no admins configured/)
  })
})

// The reset semantics doClear drives: for an in-scope account, code and storage
// always go; balance survives only under keepBalances; a non-zero nonce survives
// only under keepNonce and only for EOAs (a contract is cleared outright).
describe('clearAccounts reset semantics', () => {
  const all = (): boolean => true

  it('reduces an EOA that sent txs to nonce-only, wiping balance and storage', () => {
    const ov = new Overlay()
    ov.load(addrKey(A), { nonce: '0x3', balance: '0x64', storage: { '0x1': '0x2' } })
    const delta = ov.clearAccounts(all, { keepNonce: true, keepBalances: false })

    expect(ov.has(A)).toBe(true)
    const a = ov.get(addrKey(A))!
    expect(a.nonceSet).toBe(true)
    expect(a.nonce).toBe(3n)
    expect(a.balanceSet).toBe(false)
    expect(a.storage.size).toBe(0)
    expect([...delta.updated]).toContain(addrKey(A))
    expect([...delta.deleted]).toEqual([])
  })

  it('deletes an account with only a balance when nothing is kept', () => {
    const ov = new Overlay()
    ov.load(addrKey(B), { balance: '0x64' })
    const delta = ov.clearAccounts(all, { keepNonce: true, keepBalances: false })

    expect(ov.has(B)).toBe(false)
    expect([...delta.deleted]).toEqual([addrKey(B)])
  })

  it('fully clears a contract even with both keep flags set', () => {
    const ov = new Overlay()
    // Contract with a non-zero nonce and a balance: neither keep flag rescues it.
    ov.load(addrKey(A), { nonce: '0x1', code: '0x6001', balance: '0x64' })
    const delta = ov.clearAccounts(all, { keepNonce: true, keepBalances: true })

    expect(ov.has(A)).toBe(false)
    expect([...delta.deleted]).toEqual([addrKey(A)])
  })

  it('keeps an EOA balance when keepBalances is set', () => {
    const ov = new Overlay()
    ov.load(addrKey(A), { nonce: '0x2', balance: '0x64' })
    ov.clearAccounts(all, { keepNonce: false, keepBalances: true })

    const a = ov.get(addrKey(A))!
    expect(a.balanceSet).toBe(true)
    expect(a.balance).toBe(100n)
    expect(a.nonceSet).toBe(false)
  })

  it('respects scope — an out-of-scope account is untouched', () => {
    const ov = new Overlay()
    ov.load(addrKey(A), { balance: '0x64' })
    ov.load(addrKey(B), { balance: '0x64' })
    const onlyA = (addr: Hex): boolean => addr.toLowerCase() === A.toLowerCase()
    ov.clearAccounts(onlyA, { keepNonce: false, keepBalances: false })

    expect(ov.has(A)).toBe(false)
    expect(ov.has(B)).toBe(true)
  })
})
