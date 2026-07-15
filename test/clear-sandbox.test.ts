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
function signClear(include: Hex[], exclude: Hex[], keepNonzeroNonce: boolean, signer = account) {
  return signer.signTypedData({
    domain: { name: 'fakereum-impersonate', version: '1', chainId: Number(CHAIN_ID) },
    types: {
      ClearSandbox: [
        { name: 'include', type: 'address[]' },
        { name: 'exclude', type: 'address[]' },
        { name: 'keepNonzeroNonce', type: 'bool' },
      ],
    },
    primaryType: 'ClearSandbox',
    message: { include, exclude, keepNonzeroNonce },
  })
}

function clearReq(fields: Record<string, unknown>): RpcRequest {
  return { jsonrpc: '2.0', id: 1, method: 'fakereum_clearSandbox', params: [fields] }
}

describe('clearSandboxDigest', () => {
  it('matches a wallet EIP-712 signature over the keepNonzeroNonce flag', async () => {
    const sig = (await signClear([A], [B], true)) as Hex
    const recovered = await recoverEIP712Signer(clearSandboxDigest(CHAIN_ID, [A], [B], true), sig)
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('binds to the flag — a true signature does not verify against false', async () => {
    const sig = (await signClear([], [], true)) as Hex
    const recovered = await recoverEIP712Signer(clearSandboxDigest(CHAIN_ID, [], [], false), sig)
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })
})

describe('rpcClearSandbox', () => {
  const adminCfg = { admins: [account.address as Hex], chainId: CHAIN_ID } as unknown as Config

  it('passes the signed keepNonzeroNonce flag through to the clear fn', async () => {
    const sig = (await signClear([], [], true)) as Hex
    let seen: boolean | null = null
    const resp = await rpcClearSandbox(
      clearReq({ include: [], exclude: [], keepNonzeroNonce: true, signature: sig }),
      adminCfg,
      async (_i, _e, keep) => {
        seen = keep
        return { overlayCleared: 0, txsCleared: 0 }
      },
    )
    expect(resp.error).toBeUndefined()
    expect(seen).toBe(true)
  })

  it('defaults the flag to false when omitted', async () => {
    const sig = (await signClear([], [], false)) as Hex
    let seen: boolean | null = null
    const resp = await rpcClearSandbox(
      clearReq({ signature: sig }),
      adminCfg,
      async (_i, _e, keep) => {
        seen = keep
        return { overlayCleared: 0, txsCleared: 0 }
      },
    )
    expect(resp.error).toBeUndefined()
    expect(seen).toBe(false)
  })

  it('rejects (and does not clear) when the flag was tampered after signing', async () => {
    // Admin signed keepNonzeroNonce=true; a tampered request flips it to false.
    const sig = (await signClear([], [], true)) as Hex
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

// The keep-non-zero-nonce predicate that doClear builds, exercised against the
// Overlay building block it drives: an account with an advanced nonce survives,
// one with only a balance is wiped.
describe('clearAccounts with the keep-non-zero-nonce predicate', () => {
  it('keeps accounts whose nonce is > 0 and clears the rest', () => {
    const ov = new Overlay()
    ov.load(addrKey(A), { nonce: '0x3', balance: '0x64' }) // advanced nonce → keep
    ov.load(addrKey(B), { balance: '0x64' }) // no nonce → clear

    const shouldClear = (addr: Hex): boolean => {
      const ovl = ov.get(addrKey(addr))
      if (ovl?.nonceSet && ovl.nonce > 0n) return false
      return true
    }
    const delta = ov.clearAccounts(shouldClear)

    expect(ov.has(A)).toBe(true)
    expect(ov.has(B)).toBe(false)
    expect([...delta.deleted]).toEqual([addrKey(B)])
  })
})
