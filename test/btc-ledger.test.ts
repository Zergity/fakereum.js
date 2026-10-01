import { describe, expect, it } from 'vitest'
import { bytesToHex } from '../src/btc/bytes'
import { NETWORKS, addressToScript, scriptToAddress } from '../src/btc/address'
import { alice, bob, spend } from './btc-helpers'
import { BtcError, Ledger, type Anchor } from '../src/btc/ledger'
import { parseTx, serializeTx, type BtcTx } from '../src/btc/tx'

const NET = NETWORKS.mainnet
const ANCHOR: Anchor = { height: 900_000, hash: 'ab'.repeat(32), time: 1_800_000_000 }
const NOW = 1_800_000_100
const MIN_FEE = 1000 // sat/kvB = 1 sat/vB

function reason(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof BtcError) return e.reason
    throw e
  }
  return ''
}

function funded() {
  const l = new Ledger(ANCHOR, { minRelayFeePerKvB: MIN_FEE })
  const { stored } = l.faucet(alice.script, 100_000_000n, NOW)
  return { l, fundTxid: stored.txid, fundOutpoint: `${stored.txid}:0` }
}

describe('addresses', () => {
  it('round-trips the standard types', () => {
    const cases = [
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // P2WPKH (BIP173)
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', // P2PKH
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', // P2SH
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', // P2TR (BIP350)
    ]
    for (const a of cases) {
      const script = addressToScript(a, NET)
      expect(script, a).not.toBeNull()
      expect(scriptToAddress(script!, NET)).toBe(a)
    }
  })

  it('rejects bad checksums and wrong networks', () => {
    expect(addressToScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdp', NET)).toBeNull()
    expect(addressToScript('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', NETWORKS.testnet)).toBeNull()
    expect(addressToScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', NET)).toBeNull()
  })
})

describe('Ledger', () => {
  it('mints a faucet output in its own block on top of the anchor', () => {
    const { l, fundTxid } = funded()
    expect(l.tip().height).toBe(ANCHOR.height + 1)
    expect(l.blockAt(ANCHOR.height + 1)!.txids).toEqual([fundTxid])
    const utxos = l.unspentFor(bytesToHex(alice.script))
    expect(utxos.map((u) => u.value)).toEqual([100_000_000n])
    // A second mint is a different transaction.
    const second = l.faucet(alice.script, 100_000_000n, NOW).stored.txid
    expect(second).not.toBe(fundTxid)
    expect(l.unspentFor(bytesToHex(alice.script))).toHaveLength(2)
  })

  it('accepts a signed spend, tracks the change and marks the input spent', () => {
    const { l, fundTxid, fundOutpoint } = funded()
    const raw = spend(l, alice, [fundOutpoint], [
      { value: 30_000_000n, script: bob.script },
      { value: 69_999_000n, script: alice.script },
    ])
    const plan = l.plan(raw)
    expect(plan.fee).toBe(1000n)
    const { stored } = l.commit(plan, NOW + 10)
    expect(stored.height).toBe(ANCHOR.height + 2)
    expect(l.spent.get(fundOutpoint)).toBe(plan.txid)
    expect(l.unspentFor(bytesToHex(bob.script)).map((u) => u.value)).toEqual([30_000_000n])
    expect(l.unspentFor(bytesToHex(alice.script)).map((u) => u.value)).toEqual([69_999_000n])
    expect(l.txsFor(bytesToHex(alice.script)).map((t) => t.stored.txid)).toEqual([plan.txid, fundTxid])
  })

  it('rejects a second spend of the same output', () => {
    const { l, fundOutpoint } = funded()
    l.commit(l.plan(spend(l, alice, [fundOutpoint], [{ value: 99_999_000n, script: bob.script }])), NOW)
    const again = spend(l, alice, [fundOutpoint], [{ value: 99_998_000n, script: bob.script }])
    expect(reason(() => l.plan(again))).toContain('already spent')
  })

  it('refuses to spend an output the sandbox did not create', () => {
    const { l } = funded()
    const real = `${'11'.repeat(32)}:0`
    const raw = spend(l, alice, [real], [{ value: 1000n, script: bob.script }])
    const why = reason(() => l.plan(raw))
    expect(why).toContain('bad-txns-inputs-missingorspent')
    expect(why).toContain('real chain')
  })

  it('verifies signatures', () => {
    const { l, fundOutpoint } = funded()
    // Signed by the wrong key.
    const wrong = spend(l, bob, [fundOutpoint], [{ value: 99_999_000n, script: bob.script }])
    expect(reason(() => l.plan(wrong))).toContain('mandatory-script-verify-flag-failed')
    // Valid signature, then the output amount is changed after signing.
    const ok = spend(l, alice, [fundOutpoint], [{ value: 99_999_000n, script: bob.script }])
    expect(reason(() => l.plan(ok))).toBe('')
    const tampered = parseTx(ok)
    tampered.outputs[0]!.value -= 1n // the signature commits to the output amount
    expect(reason(() => l.plan(serializeTx(tampered)))).toContain('mandatory-script-verify-flag-failed')
  })

  it('enforces value and fee rules', () => {
    const { l, fundOutpoint } = funded()
    const over = spend(l, alice, [fundOutpoint], [{ value: 100_000_001n, script: bob.script }])
    expect(reason(() => l.plan(over))).toBe('bad-txns-in-belowout')
    const nofee = spend(l, alice, [fundOutpoint], [{ value: 100_000_000n, script: bob.script }])
    expect(reason(() => l.plan(nofee))).toContain('min relay fee not met')
  })

  it('enforces nLockTime against the next block height', () => {
    const { l, fundOutpoint } = funded()
    const lockedUntil = ANCHOR.height + 5
    const raw = spend(l, alice, [fundOutpoint], [{ value: 99_999_000n, script: bob.script }], { locktime: lockedUntil })
    expect(reason(() => l.plan(raw))).toBe('non-final')
    l.mine(5, NOW)
    expect(reason(() => l.plan(raw))).toBe('')
  })

  it('rejects malformed and coinbase-shaped transactions', () => {
    const { l } = funded()
    expect(reason(() => l.plan(Uint8Array.of(1, 2, 3)))).toContain('TX decode failed')
    const cb: BtcTx = {
      version: 1,
      inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: Uint8Array.of(1, 1), sequence: 0xffffffff, witness: [] }],
      outputs: [{ value: 1n, script: alice.script }],
      locktime: 0,
    }
    expect(reason(() => l.plan(serializeTx(cb)))).toBe('coinbase')
  })

  it('rebuilds identical state from its persisted rows', () => {
    const { l, fundOutpoint } = funded()
    l.commit(l.plan(spend(l, alice, [fundOutpoint], [{ value: 99_999_000n, script: bob.script }])), NOW)
    l.mine(2, NOW + 60)

    const copy = new Ledger(ANCHOR, { minRelayFeePerKvB: MIN_FEE })
    copy.load(l.blocks, [...l.txs.values()].map((t) => t.stored))
    expect(copy.tip()).toEqual(l.tip())
    expect([...copy.spent]).toEqual([...l.spent])
    expect(copy.unspentFor(bytesToHex(bob.script))).toEqual(l.unspentFor(bytesToHex(bob.script)))
    // Faucet seeds keep advancing after a reload, so a new mint cannot collide.
    const next = copy.faucet(alice.script, 1n, NOW + 120).stored.txid
    expect(l.txs.has(next)).toBe(false)
  })
})
