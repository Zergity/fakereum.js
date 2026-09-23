// The stateOverrides a forwarded eth_call carries: the whole overlay while it
// is small, and past FILTER_OVERRIDES_MIN_BYTES only the entries a speculative
// local run of the call actually read (Executor.overridesForCall,
// Overlay.asStateOverridesFor). Also the per-account entry cache behind
// asStateOverrides and its invalidation.
import { describe, expect, it } from 'vitest'
import { Executor } from '../src/executor'
import { Overlay } from '../src/overlay'
import { Fetcher } from '../src/fetcher'
import { Impersonators } from '../src/impersonate/store'
import { AccountKinds } from '../src/account_kind'
import type { Upstream } from '../src/upstream'
import { TouchedState } from '../src/statemanager'
import { addrKey, checksumAddress, toQuantity, type Hex } from '../src/lib/hex'
import type { Config } from '../src/types'

const cfg = { chainId: 4201n, upstreamChainId: 1n, networkName: 'Fake Test Chain', rejectUpstreamSigners: false } as unknown as Config
const FROM = '0x1111111111111111111111111111111111111111' as Hex
const LEDGER = '0x2222222222222222222222222222222222222222' as Hex
const ARB_SYS = '0x0000000000000000000000000000000000000064' as Hex

// Runtime that returns storage[calldata[0:32]]:
//   PUSH1 0 CALLDATALOAD SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
// so the slot a call reads is exactly the word it passes.
const LEDGER_CODE = '0x6000355460005260206000f3'
const word = (n: bigint): Hex => ('0x' + n.toString(16).padStart(64, '0')) as Hex
const readSlot = (slot: Hex) => ({ from: FROM, to: LEDGER, data: slot })

function stubUpstream(): Upstream {
  const tip = {
    number: '0x100',
    timestamp: toQuantity(BigInt(Math.floor(Date.now() / 1000))),
    baseFeePerGas: toQuantity(10n ** 9n),
    gasLimit: toQuantity(30_000_000n),
    miner: '0x4444444444444444444444444444444444444444',
    difficulty: '0x0',
    mixHash: '0x' + '00'.repeat(32),
    hash: '0x' + 'ee'.repeat(32),
  }
  const answer = (m: string): unknown => {
    switch (m) {
      case 'eth_getBlockByNumber':
        return tip
      case 'eth_getCode':
        return '0x'
      case 'eth_getStorageAt':
        return '0x' + '00'.repeat(32)
      case 'eth_gasPrice':
        return toQuantity(2n * 10n ** 9n)
      default:
        return '0x0'
    }
  }
  return {
    async callResult(m: string) {
      return answer(m)
    },
    async batch(reads: Array<{ method: string }>) {
      return reads.map((r) => ({ jsonrpc: '2.0', id: 1, result: answer(r.method) }))
    },
    async call() {
      return { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }
    },
  } as unknown as Upstream
}

/** A ledger contract with `slots` written slots, plus `padded` 24KB contracts nobody calls. */
function setup(slots: number, padded: number, overrideFilterMinBytes = 256 * 1024) {
  const overlay = new Overlay()
  const storage: Record<string, Hex> = {}
  for (let i = 1; i <= slots; i++) storage[word(BigInt(i))] = word(BigInt(i) * 10n)
  overlay.load(addrKey(LEDGER), { nonce: '0x1', code: LEDGER_CODE as Hex, storage })
  const junk = ('0x' + '00'.repeat(24000)) as Hex
  const others: Hex[] = []
  for (let i = 0; i < padded; i++) {
    const a = ('0x' + 'aa'.repeat(19) + (i + 1).toString(16).padStart(2, '0')) as Hex
    others.push(a)
    overlay.load(addrKey(a), { nonce: '0x1', code: junk })
  }
  overlay.load(addrKey(FROM), { balance: toQuantity(10n ** 18n), nonce: '0x5' })
  const fetcher = new Fetcher(stubUpstream(), 60_000, new Map())
  const kinds = new AccountKinds((a) => fetcher.getBalanceUncached(a), { put: async () => {} })
  const executor = new Executor(overlay, fetcher, { ...cfg, overrideFilterMinBytes }, new Impersonators(), kinds)
  return { overlay, executor, others }
}

describe('Executor.overridesForCall', () => {
  it('the ledger fixture answers a slot read locally', async () => {
    const { executor } = setup(10, 0)
    const r = await executor.call(readSlot(word(7n)), null)
    expect(r.error).toBeUndefined()
    expect(BigInt(r.returnData)).toBe(70n)
  })

  it('ships the whole overlay while it is small', async () => {
    const { overlay, executor } = setup(50, 1)
    expect(overlay.approxOverrideBytes()).toBeLessThan(256 * 1024)
    const got = await executor.overridesForCall(readSlot(word(7n)), null)
    expect(got).toEqual(overlay.asStateOverrides())
    expect(Object.keys(got)).toHaveLength(3)
  })

  it('past the threshold keeps only the accounts and slots the call read', async () => {
    const { overlay, executor, others } = setup(2000, 8)
    expect(overlay.approxOverrideBytes()).toBeGreaterThan(256 * 1024)
    const full = JSON.stringify(overlay.asStateOverrides()).length

    const got = await executor.overridesForCall(readSlot(word(7n)), null)
    // the ledger (touched) and the sender (always carried); none of the 8 uncalled contracts
    expect(Object.keys(got).sort()).toEqual([checksumAddress(LEDGER), checksumAddress(FROM)].sort())
    for (const a of others) expect(got[checksumAddress(a)]).toBeUndefined()
    const ledger = got[checksumAddress(LEDGER)]!
    expect(ledger.code).toBe(LEDGER_CODE)
    expect(ledger.nonce).toBe('0x1')
    // exactly the one slot the call read, out of 2000 in the overlay
    expect(ledger.stateDiff).toEqual({ [word(7n)]: word(70n) })
    expect(got[checksumAddress(FROM)]).toEqual({ balance: toQuantity(10n ** 18n), nonce: '0x5' })

    const filtered = JSON.stringify(got).length
    expect(filtered).toBeLessThan(2 * 1024)
    expect(filtered * 100).toBeLessThan(full)
  })

  it('a different call to the same contract picks a different slot', async () => {
    const { executor } = setup(2000, 8)
    const got = await executor.overridesForCall(readSlot(word(1500n)), null)
    expect(got[checksumAddress(LEDGER)]!.stateDiff).toEqual({ [word(1500n)]: word(15000n) })
  })

  it('a slot the overlay does not hold adds nothing', async () => {
    const { executor } = setup(2000, 8)
    const got = await executor.overridesForCall(readSlot(word(99_999n)), null)
    expect(got[checksumAddress(LEDGER)]!.stateDiff).toBeUndefined()
    expect(got[checksumAddress(LEDGER)]!.code).toBe(LEDGER_CODE)
  })

  it('OVERRIDE_FILTER_MIN_BYTES: -1 never filters, 0 always does', async () => {
    const never = setup(2000, 8, -1)
    expect(await never.executor.overridesForCall(readSlot(word(7n)), null)).toEqual(never.overlay.asStateOverrides())
    const always = setup(50, 0, 0)
    const got = await always.executor.overridesForCall(readSlot(word(7n)), null)
    expect(got[checksumAddress(LEDGER)]!.stateDiff).toEqual({ [word(7n)]: word(70n) })
  })

  it('falls back to the whole overlay when the run reaches a chain-specific precompile', async () => {
    const { overlay, executor } = setup(2000, 8)
    const got = await executor.overridesForCall({ from: FROM, to: ARB_SYS, data: '0xa3b1b31d' }, null)
    expect(got).toEqual(overlay.asStateOverrides())
  })

  it('honors caller-supplied overrides while speculating', async () => {
    const { executor } = setup(2000, 8)
    // The caller redirects the ledger's code to one that reads slot 3 whatever
    // the calldata says: PUSH1 3 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
    const code = new Uint8Array([0x60, 0x03, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3])
    const got = await executor.overridesForCall(readSlot(word(7n)), new Map([[addrKey(LEDGER), { code }]]))
    expect(got[checksumAddress(LEDGER)]!.stateDiff).toEqual({ [word(3n)]: word(30n) })
  })
})

describe('Overlay.asStateOverridesFor', () => {
  it('emits touched accounts with only their touched slots, and account fields for extras', () => {
    const { overlay, others } = setup(10, 2)
    const t = new TouchedState()
    t.account(addrKey(LEDGER))
    t.slot(addrKey(LEDGER), word(4n))
    t.slot(addrKey(LEDGER), word(99n)) // not in the overlay: skipped
    t.account(addrKey(others[0]!))
    const got = overlay.asStateOverridesFor(t, [FROM, LEDGER])
    expect(Object.keys(got).sort()).toEqual([checksumAddress(LEDGER), checksumAddress(others[0]!), checksumAddress(FROM)].sort())
    expect(got[checksumAddress(LEDGER)]!.stateDiff).toEqual({ [word(4n)]: word(40n) })
    expect(got[checksumAddress(others[0]!)]!.stateDiff).toBeUndefined()
    expect(got[checksumAddress(FROM)]).toEqual({ balance: toQuantity(10n ** 18n), nonce: '0x5' })
  })

  it('an extra account contributes its fields but never its storage', () => {
    const { overlay } = setup(10, 0)
    const got = overlay.asStateOverridesFor(new TouchedState(), [LEDGER])
    expect(got[checksumAddress(LEDGER)]).toEqual({ nonce: '0x1', code: LEDGER_CODE })
  })
})

describe('Overlay override entry cache', () => {
  it('reuses entries across calls and drops them when the account changes', () => {
    const { overlay } = setup(10, 1)
    const a = overlay.asStateOverrides()
    const b = overlay.asStateOverrides()
    expect(b[checksumAddress(LEDGER)]).toBe(a[checksumAddress(LEDGER)]) // same cached object
    const before = overlay.approxOverrideBytes()

    overlay.commit([
      {
        addr: LEDGER,
        selfDestructed: false,
        balanceSet: false,
        balance: 0n,
        nonceSet: false,
        nonce: 0n,
        codeSet: false,
        code: new Uint8Array(0),
        storage: new Map([[word(4n), word(41n)], [word(11n), word(110n)]]),
      },
    ])
    const c = overlay.asStateOverrides()
    expect(c[checksumAddress(LEDGER)]).not.toBe(a[checksumAddress(LEDGER)])
    expect(c[checksumAddress(LEDGER)]!.stateDiff![word(4n)]).toBe(word(41n))
    expect(overlay.approxOverrideBytes()).toBeGreaterThan(before)
    // an untouched account keeps its cached entry
    expect(c[checksumAddress(FROM)]).toBe(a[checksumAddress(FROM)])
  })

  it('the size estimate tracks the real JSON within a few percent', () => {
    const { overlay } = setup(3000, 5)
    const real = JSON.stringify(overlay.asStateOverrides()).length
    const approx = overlay.approxOverrideBytes()
    expect(Math.abs(approx - real) / real).toBeLessThan(0.05)
  })
})
