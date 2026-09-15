// createSandboxProvider routing, with a fake wallet and a fake sandbox behind
// a stubbed global fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSandboxProvider, ProviderRpcError, type EIP1193Provider } from '../src/index'
import { abiEncodeString, buildInfos } from '../../src/infos'
import type { Config } from '../../src/types'

const RPC = 'https://sandbox.test/rpc'
const ACCT = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const TO = '0x3333333333333333333333333333333333333333'
const SIG = ('0x' + '11'.repeat(64) + '1b') as `0x${string}`
const HASH = '0x' + 'aa'.repeat(32)

const infos = buildInfos(
  { chainId: 42161n, upstreamChainId: 42161n, networkName: 'Fake Arbitrum One', symbol: 'FETH', upstreamRpcs: [] } as unknown as Config,
  'https://sandbox.test',
)
const INFOS_HEX = abiEncodeString(new TextEncoder().encode(JSON.stringify(infos)))

type Kind = { kind: 'sandbox' | 'upstream'; pinned: boolean }

function fakeSandbox(kinds: Record<string, Kind>) {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(RPC)
    const { method, params } = JSON.parse(init.body as string)
    calls.push({ method, params })
    let result: unknown
    switch (method) {
      case 'eth_call':
        result = INFOS_HEX
        break
      case 'fakereum_accountKind': {
        const k = kinds[(params[0] as string).toLowerCase()] ?? { kind: 'sandbox', pinned: false }
        result = { address: params[0], ...k, replayGuard: true }
        break
      }
      case 'fakereum_transactionMessage':
        result = { message: 'Fakereum Tx #5 on Arbitrum One\nTo: ' + TO, nonce: '0x5' }
        break
      case 'fakereum_sendTransaction':
        result = HASH
        break
      case 'eth_getBalance':
        result = '0x1'
        break
      default:
        result = 'sandbox:' + method
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  })
  return { calls, fetchMock }
}

function fakeWallet(opts: { onSandbox?: boolean } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const wallet: EIP1193Provider & { emit: (e: string, ...a: unknown[]) => void } = {
    async request({ method, params }) {
      calls.push({ method, params })
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [ACCT]
        case 'eth_call':
          return opts.onSandbox ? INFOS_HEX : '0x' // the wallet's own RPC: sandbox or a real chain
        case 'personal_sign':
          return SIG
        case 'eth_sendTransaction':
          return '0x' + 'bb'.repeat(32)
        case 'eth_signTypedData_v4':
          return '0xsigned-typed-data'
        default:
          return 'wallet:' + method
      }
    },
    on(event, l) {
      listeners.set(event, [...(listeners.get(event) ?? []), l])
    },
    removeListener() {},
    emit(event, ...a) {
      for (const l of listeners.get(event) ?? []) l(...a)
    },
  }
  return { wallet, calls }
}

describe('createSandboxProvider', () => {
  let sandbox: ReturnType<typeof fakeSandbox>
  beforeEach(() => {
    sandbox = fakeSandbox({ [ACCT]: { kind: 'sandbox', pinned: false }, [OTHER]: { kind: 'upstream', pinned: true } })
    vi.stubGlobal('fetch', sandbox.fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('routes state reads to the sandbox and account / signing methods to the wallet', async () => {
    const { wallet, calls } = fakeWallet()
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    expect(await p.request({ method: 'eth_getBalance', params: [ACCT, 'latest'] })).toBe('0x1')
    expect(await p.request({ method: 'eth_blockNumber' })).toBe('sandbox:eth_blockNumber')
    expect(await p.request({ method: 'eth_chainId' })).toBe('sandbox:eth_chainId')
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([ACCT])
    expect(await p.request({ method: 'personal_sign', params: ['hi', ACCT] })).toBe(SIG)
    expect(await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })).toBe('wallet:wallet_switchEthereumChain')
    expect(calls.map((c) => c.method)).toEqual(['eth_requestAccounts', 'personal_sign', 'wallet_switchEthereumChain'])
    expect(p.isFakereum).toBe(true)
    expect((await p.infos()).networkName).toBe('Fake Arbitrum One')
  })

  it('wallet on a real chain (fork-aware dapp): eth_sendTransaction becomes a signed-message tx', async () => {
    const { wallet, calls } = fakeWallet({ onSandbox: false })
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    const hash = await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, value: '0x38d7ea4c68000', data: '0x12', gas: '0x5208' }] })
    expect(hash).toBe(HASH)
    // the wallet only ever signed a message
    expect(calls.map((c) => c.method)).toEqual(['eth_call', 'personal_sign'])
    expect(calls[1]!.params).toEqual(['Fakereum Tx #5 on Arbitrum One\nTo: ' + TO, ACCT])
    const sent = sandbox.calls.find((c) => c.method === 'fakereum_sendTransaction')!
    expect(sent.params).toEqual([{ to: TO, data: '0x12', value: '0x38d7ea4c68000', nonce: '0x5', gas: '0x5208', signature: SIG }])
    const asked = sandbox.calls.find((c) => c.method === 'fakereum_transactionMessage')!
    expect(asked.params).toEqual([{ from: ACCT, to: TO, data: '0x12', value: '0x38d7ea4c68000', gas: '0x5208' }])
  })

  it("wallet already on this sandbox: a 'sandbox' account sends through the wallet, an 'upstream' one as a message", async () => {
    const { wallet, calls } = fakeWallet({ onSandbox: true })
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).toBe('0x' + 'bb'.repeat(32))
    expect(calls.map((c) => c.method)).toEqual(['eth_call', 'eth_sendTransaction'])
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ from: OTHER, to: TO }] })).toBe(HASH)
    expect(calls.map((c) => c.method).slice(2)).toEqual(['personal_sign'])
  })

  it("sendMode 'message' forces signed messages even when the wallet is on the sandbox", async () => {
    const { wallet, calls } = fakeWallet({ onSandbox: true })
    const p = createSandboxProvider({ sandbox: RPC, wallet, sendMode: 'message' })
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ to: TO }] })).toBe(HASH) // from = eth_accounts[0]
    expect(calls.map((c) => c.method)).toEqual(['eth_accounts', 'personal_sign'])
  })

  it("refuses typed-data and eth_sign for an 'upstream' account, allows them for a 'sandbox' one", async () => {
    const { wallet } = fakeWallet()
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    expect(await p.request({ method: 'eth_signTypedData_v4', params: [ACCT, '{}'] })).toBe('0xsigned-typed-data')
    const err = await p.request({ method: 'eth_signTypedData_v4', params: [OTHER, '{}'] }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderRpcError)
    expect(err.code).toBe(4100)
    expect(err.message).toMatch(/real chain/)
    await expect(p.request({ method: 'eth_sign', params: [OTHER, '0x' + '00'.repeat(32)] })).rejects.toMatchObject({ code: 4100 })
    await expect(p.request({ method: 'eth_signTypedData', params: [[{ type: 'string', name: 'x', value: 'y' }], OTHER] })).rejects.toMatchObject({ code: 4100 })
  })

  it('caches kinds: unpinned entries refresh on accountsChanged and after a send, pinned ones are frozen', async () => {
    const { wallet } = fakeWallet({ onSandbox: false })
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    const kindCalls = () => sandbox.calls.filter((c) => c.method === 'fakereum_accountKind').length

    await p.kind(ACCT)
    await p.kind(ACCT)
    await p.kind(OTHER)
    await p.kind(OTHER)
    expect(kindCalls()).toBe(2) // one per address

    wallet.emit('accountsChanged', [ACCT])
    await p.kind(OTHER)
    expect(kindCalls()).toBe(2) // pinned: frozen
    await p.kind(ACCT)
    expect(kindCalls()).toBe(3) // unpinned: refetched

    await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    await new Promise((r) => setTimeout(r, 0))
    expect(kindCalls()).toBe(4) // a landed send pins the account server-side: refetch once
  })
})
