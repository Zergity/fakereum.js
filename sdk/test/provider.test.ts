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
const HASH = '0x' + 'aa'.repeat(32)

// The fake wallet's "signature" just carries the signer, so the fake sandbox can
// recover it the way the real one recovers an EIP-191 signer.
const sigFor = (addr: string): `0x${string}` => ('0x' + addr.slice(2).toLowerCase().padStart(128, '0') + '1b') as `0x${string}`
const signerOf = (sig: string): string => '0x' + sig.slice(2, 130).slice(-40)
const SIG = sigFor(ACCT)

const infos = buildInfos(
  { chainId: 42161n, upstreamChainId: 42161n, networkName: 'Fake Arbitrum One', symbol: 'FETH', upstreamRpcs: [] } as unknown as Config,
  'https://sandbox.test',
)
const INFOS_HEX = abiEncodeString(new TextEncoder().encode(JSON.stringify(infos)))

type Kind = { kind: 'sandbox' | 'upstream'; pinned: boolean }

function fakeSandbox(kinds: Record<string, Kind>, start: Record<string, number> = {}, onSend?: () => Promise<void>) {
  const calls: Array<{ method: string; params: unknown[] }> = []
  /** Landed sends, in the order the sandbox accepted them. */
  const landed: Array<{ from: string; nonce: bigint }> = []
  const nonces = new Map<string, bigint>(Object.entries(start).map(([a, n]) => [a.toLowerCase(), BigInt(n)]))
  const nonceOf = (a: string): bigint => nonces.get(a.toLowerCase()) ?? 5n

  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(RPC)
    const { method, params } = JSON.parse(init.body as string)
    calls.push({ method, params })
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    const fail = (message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }))

    switch (method) {
      case 'eth_call':
        return ok(INFOS_HEX)
      case 'fakereum_accountKind': {
        const k = kinds[(params[0] as string).toLowerCase()] ?? { kind: 'sandbox', pinned: false }
        return ok({ address: params[0], ...k, replayGuard: true })
      }
      case 'eth_getTransactionCount':
        return ok('0x' + nonceOf(params[0] as string).toString(16))
      case 'fakereum_transactionMessage': {
        const p = params[0] as { from?: string; to?: string; nonce?: string }
        const n = p.nonce !== undefined ? BigInt(p.nonce) : nonceOf(p.from!)
        return ok({ message: `Fakereum Tx #${n} on Arbitrum One\nTo: ${p.to}`, nonce: '0x' + n.toString(16) })
      }
      case 'fakereum_sendTransaction': {
        // No mempool: the signed nonce has to equal the account's current one.
        if (onSend) await onSend()
        const p = params[0] as { nonce: string; signature: string }
        const from = signerOf(p.signature)
        const want = nonceOf(from)
        if (BigInt(p.nonce) !== want) {
          return fail(`the tx doesn't have the correct nonce. account has nonce of: ${want} tx has nonce of: ${BigInt(p.nonce)}`)
        }
        nonces.set(from.toLowerCase(), want + 1n)
        landed.push({ from, nonce: want })
        return ok(HASH)
      }
      case 'eth_getBalance':
        return ok('0x1')
      case 'fakereum_clearSandbox':
        nonces.clear()
        return ok(true)
      default:
        return ok('sandbox:' + method)
    }
  })
  return { calls, landed, nonces, fetchMock }
}

function fakeWallet(opts: { onSandbox?: boolean; onSign?: (message: string, from: string) => Promise<unknown> } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const wallet: EIP1193Provider & { emit: (e: string, ...a: unknown[]) => void } = {
    async request({ method, params }) {
      calls.push({ method, params })
      const p = (params ?? []) as unknown[]
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [ACCT]
        case 'eth_call':
          return opts.onSandbox ? INFOS_HEX : '0x' // the wallet's own RPC: sandbox or a real chain
        case 'personal_sign':
          if (opts.onSign) await opts.onSign(p[0] as string, p[1] as string)
          return sigFor(p[1] as string)
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
    // the nonce is picked here and passed in, not re-read while building the message
    const asked = sandbox.calls.find((c) => c.method === 'fakereum_transactionMessage')!
    expect(asked.params).toEqual([{ from: ACCT, to: TO, data: '0x12', value: '0x38d7ea4c68000', nonce: '0x5', gas: '0x5208' }])
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

describe('nonces on concurrent signed-message sends', () => {
  let sandbox: ReturnType<typeof fakeSandbox>
  beforeEach(() => {
    sandbox = fakeSandbox({ [ACCT]: { kind: 'upstream', pinned: true }, [OTHER]: { kind: 'upstream', pinned: true } }, { [ACCT]: 5, [OTHER]: 9 })
    vi.stubGlobal('fetch', sandbox.fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** A signing prompt that only resolves when the test says so. */
  function gatedSigner() {
    const pending: Array<() => void> = []
    const seen: string[] = []
    const onSign = (message: string) => {
      seen.push(message)
      return new Promise<void>((resolve) => pending.push(resolve))
    }
    return { onSign, pending, seen }
  }

  it('two sends fired together take consecutive nonces, one prompt at a time', async () => {
    const gate = gatedSigner()
    const { wallet } = fakeWallet({ onSign: gate.onSign })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    const a = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    const b = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, value: '0x1' }] })
    await new Promise((r) => setTimeout(r, 0))

    // only one prompt is open: the second send is still waiting to be signed
    expect(gate.pending.length).toBe(1)
    expect(gate.seen).toEqual(['Fakereum Tx #5 on Arbitrum One\nTo: ' + TO])

    gate.pending[0]!()
    await a
    await new Promise((r) => setTimeout(r, 0))
    expect(gate.seen[1]).toBe('Fakereum Tx #6 on Arbitrum One\nTo: ' + TO)

    gate.pending[1]!()
    await b
    expect(sandbox.landed).toEqual([
      { from: ACCT, nonce: 5n },
      { from: ACCT, nonce: 6n },
    ])
  })

  it('the next nonce is spent at the signature, not at the landing: the second prompt opens while the first is still submitting', async () => {
    let releaseSend: () => void = () => {}
    const held = new Promise<void>((r) => (releaseSend = r))
    let holds = true
    sandbox = fakeSandbox({ [ACCT]: { kind: 'upstream', pinned: true } }, { [ACCT]: 5 }, async () => {
      if (holds) {
        holds = false
        await held
      }
    })
    vi.stubGlobal('fetch', sandbox.fetchMock)

    const gate = gatedSigner()
    const { wallet } = fakeWallet({ onSign: gate.onSign })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    const a = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    const b = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, value: '0x1' }] })
    await new Promise((r) => setTimeout(r, 0))
    expect(gate.seen).toEqual(['Fakereum Tx #5 on Arbitrum One\nTo: ' + TO])

    gate.pending[0]!() // the wallet hands back the first signature; its submit is held open
    await new Promise((r) => setTimeout(r, 0))
    expect(p.nonces.peek(ACCT)).toBe(6n) // spent already
    expect(sandbox.landed).toEqual([]) // nothing has landed
    expect(gate.seen[1]).toBe('Fakereum Tx #6 on Arbitrum One\nTo: ' + TO) // …yet the second prompt is open

    gate.pending[1]!() // sign the second while the first is still in flight
    await new Promise((r) => setTimeout(r, 0))
    expect(sandbox.landed).toEqual([]) // submits stay in order: #6 waits for #5

    releaseSend()
    expect(await Promise.all([a, b])).toEqual([HASH, HASH])
    expect(sandbox.landed).toEqual([
      { from: ACCT, nonce: 5n },
      { from: ACCT, nonce: 6n },
    ])
  })

  it('a failed submit strands the follower it already signed, and the send after that recovers', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    let first = true
    sandbox = fakeSandbox({ [ACCT]: { kind: 'upstream', pinned: true } }, { [ACCT]: 5 }, async () => {
      if (!first) return
      first = false
      await held
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', sandbox.fetchMock)

    const gate = gatedSigner()
    const { wallet } = fakeWallet({ onSign: gate.onSign })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    const a = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    const b = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, value: '0x1' }] })
    await new Promise((r) => setTimeout(r, 0))
    gate.pending[0]!() // #5 signed, its submit hangs
    await new Promise((r) => setTimeout(r, 0))
    gate.pending[1]!() // #6 signed off the back of it
    await new Promise((r) => setTimeout(r, 0))

    release() // …and now #5 never lands
    await expect(a).rejects.toThrow(/network down/)
    await expect(b).rejects.toThrow(/correct nonce/) // #6 was signed against a nonce that never arrived
    expect(p.nonces.peek(ACCT)).toBeUndefined()

    // the account is untouched, so the next send takes 5 again
    const c = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    await new Promise((r) => setTimeout(r, 0))
    expect(gate.seen[2]).toBe('Fakereum Tx #5 on Arbitrum One\nTo: ' + TO)
    gate.pending[2]!()
    expect(await c).toBe(HASH)
    expect(sandbox.landed).toEqual([{ from: ACCT, nonce: 5n }])
  })

  it('a malformed signature spends nothing and is never submitted', async () => {
    const { wallet } = fakeWallet({ onSign: async () => {} })
    const bad: EIP1193Provider = {
      request: (args) => (args.method === 'personal_sign' ? Promise.resolve('0xdeadbeef') : wallet.request(args)),
    }
    const p = createSandboxProvider({ sandbox: RPC, wallet: bad })

    await expect(p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).rejects.toThrow(/malformed signature/)
    expect(p.nonces.peek(ACCT)).toBeUndefined()
    expect(sandbox.calls.some((c) => c.method === 'fakereum_sendTransaction')).toBe(false)
  })

  it('different accounts are not serialized against each other', async () => {
    const gate = gatedSigner()
    const { wallet } = fakeWallet({ onSign: gate.onSign })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    const a = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    const b = p.request({ method: 'eth_sendTransaction', params: [{ from: OTHER, to: TO }] })
    await new Promise((r) => setTimeout(r, 0))

    expect(gate.pending.length).toBe(2)
    expect(gate.seen.sort()).toEqual(['Fakereum Tx #5 on Arbitrum One\nTo: ' + TO, 'Fakereum Tx #9 on Arbitrum One\nTo: ' + TO])
    gate.pending[0]!()
    gate.pending[1]!()
    await Promise.all([a, b])
    expect(sandbox.landed.map((l) => l.nonce).sort()).toEqual([5n, 9n])
  })

  it('a rejected signature frees the nonce for the next send', async () => {
    let reject = true
    const { wallet } = fakeWallet({
      onSign: async () => {
        if (reject) throw new ProviderRpcError(4001, 'User rejected the request.')
      },
    })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    await expect(p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).rejects.toMatchObject({ code: 4001 })
    reject = false
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).toBe(HASH)
    expect(sandbox.landed).toEqual([{ from: ACCT, nonce: 5n }]) // the rejected one did not burn nonce 5
  })

  it('cancelling the first of two queued sends hands its nonce to the second', async () => {
    const gate = gatedSigner()
    const reject: Array<(e: unknown) => void> = []
    const { wallet } = fakeWallet({
      onSign: (message) => {
        gate.seen.push(message)
        return new Promise<void>((resolve, rejectFn) => {
          gate.pending.push(resolve)
          reject.push(rejectFn)
        })
      },
    })
    const p = createSandboxProvider({ sandbox: RPC, wallet })

    const a = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    const b = p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, value: '0x1' }] })
    await new Promise((r) => setTimeout(r, 0))
    expect(gate.seen).toEqual(['Fakereum Tx #5 on Arbitrum One\nTo: ' + TO])

    reject[0]!(new ProviderRpcError(4001, 'User rejected the request.'))
    await expect(a).rejects.toMatchObject({ code: 4001 }) // the dapp still sees the cancellation
    await new Promise((r) => setTimeout(r, 0))

    // the second prompt opens on nonce 5 — the cancelled one never took it
    expect(gate.seen[1]).toBe('Fakereum Tx #5 on Arbitrum One\nTo: ' + TO)
    gate.pending[1]!()
    expect(await b).toBe(HASH)
    expect(sandbox.landed).toEqual([{ from: ACCT, nonce: 5n }])
  })

  it('an explicit tx.nonce is used as given', async () => {
    const { wallet } = fakeWallet()
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    await expect(p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO, nonce: '0x7' }] })).rejects.toThrow(/correct nonce/)
    expect(sandbox.calls.some((c) => c.method === 'eth_getTransactionCount')).toBe(false)
  })

  it('follows the sandbox when it moves the account on by itself', async () => {
    const { wallet } = fakeWallet()
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    expect(p.nonces.peek(ACCT)).toBe(6n)

    sandbox.nonces.set(ACCT.toLowerCase(), 11n) // the same account sent from somewhere else
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).toBe(HASH)
    expect(sandbox.landed.map((l) => l.nonce)).toEqual([5n, 11n])
  })

  it('drops a hint the sandbox has rewound past, and forgets everything when the sandbox is cleared', async () => {
    const { wallet } = fakeWallet()
    const p = createSandboxProvider({ sandbox: RPC, wallet })
    await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })
    expect(p.nonces.peek(ACCT)).toBe(6n)

    sandbox.nonces.set(ACCT.toLowerCase(), 2n) // rewound underneath us
    await expect(p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).rejects.toThrow(/correct nonce/)
    expect(p.nonces.peek(ACCT)).toBeUndefined() // the stale hint is gone
    expect(await p.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: TO }] })).toBe(HASH)
    expect(sandbox.landed.map((l) => l.nonce)).toEqual([5n, 2n])

    await p.request({ method: 'fakereum_clearSandbox' })
    expect(p.nonces.peek(ACCT)).toBeUndefined()
  })
})
