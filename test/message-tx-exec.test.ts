// End-to-end through the Executor: an EIP-191 message tx becomes a real EVM
// run against overlay + a stubbed upstream. The stub answers only the plain
// state reads; the batched prefetch / access-list helpers fail and fall back
// to the lazy per-read path, which is exactly the "source of correctness" the
// executor documents.
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { Executor, type MessageTx } from '../src/executor'
import { Overlay } from '../src/overlay'
import { Fetcher } from '../src/fetcher'
import { Impersonators } from '../src/impersonate/store'
import { AccountKinds } from '../src/account_kind'
import type { Upstream } from '../src/upstream'
import { transactionMessage, type MessageTxFields } from '../src/lib/eip191'
import { keccak256, parseTransaction } from 'viem'
import { addrKey, hexToBytes, toBigInt, toQuantity, type Hex } from '../src/lib/hex'
import type { Config } from '../src/types'

// Throwaway keys (hardhat accounts #1 and #2); never funded on any real chain.
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const impersonator = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const TO = '0x2222222222222222222222222222222222222222' as Hex
const IMPERSONATEE = '0x3333333333333333333333333333333333333333' as Hex
const NETWORK = 'Fake Test Chain'
const CHAIN_ID = 4201n
const ETH = 10n ** 18n

const cfg = {
  chainId: CHAIN_ID,
  upstreamChainId: 1n,
  networkName: NETWORK,
  rejectUpstreamSigners: false,
} as unknown as Config

/** Upstream stub: accounts are empty except `nonces` / `balances`; head block is fixed. */
function stubUpstream(nonces: Record<string, bigint>, balances: Record<string, bigint> = {}): Upstream {
  const tip = {
    number: '0x100',
    timestamp: toQuantity(BigInt(Math.floor(Date.now() / 1000))),
    baseFeePerGas: toQuantity(10n ** 9n), // 1 gwei, so a zero-fee tx must lower it
    gasLimit: toQuantity(30_000_000n),
    miner: '0x4444444444444444444444444444444444444444',
    difficulty: '0x0',
    mixHash: '0x' + '00'.repeat(32),
    hash: '0x' + 'ee'.repeat(32),
  }
  return {
    async callResult(method: string, params: unknown[]) {
      switch (method) {
        case 'eth_getBlockByNumber':
          return tip
        case 'eth_getBalance':
          return toQuantity(balances[addrKey(params[0] as string)] ?? 0n)
        case 'eth_getTransactionCount':
          return toQuantity(nonces[addrKey(params[0] as string)] ?? 0n)
        case 'eth_getCode':
          return '0x'
        case 'eth_getStorageAt':
          return '0x' + '00'.repeat(32)
        case 'eth_gasPrice':
          return toQuantity(2n * 10n ** 9n)
        default:
          throw new Error(`stub: ${method} unsupported`)
      }
    },
    async batch() {
      throw new Error('stub: no batch')
    },
    async call() {
      throw new Error('stub: no call')
    },
  } as unknown as Upstream
}

function setup(
  nonces: Record<string, bigint>,
  funded: Hex[],
  opts: { upstreamBalances?: Record<string, bigint>; config?: Config } = {},
) {
  const overlay = new Overlay()
  const alloc: Record<string, { balance: string }> = {}
  for (const a of funded) alloc[a] = { balance: toQuantity(ETH) }
  overlay.applyGenesis({ alloc })
  const fetcher = new Fetcher(stubUpstream(nonces, opts.upstreamBalances), 0, new Map())
  const impersonators = new Impersonators()
  const kinds = new AccountKinds(
    (a) => fetcher.getBalanceUncached(a),
    { put: async () => {} },
  )
  const executor = new Executor(overlay, fetcher, opts.config ?? cfg, impersonators, kinds)
  return { overlay, executor, impersonators, kinds }
}

const GWEI = 10n ** 9n

/** Sign a message tx. Unsigned gas terms default to 100k gas at a 1559 cap of 2 gwei, no tip. */
async function signedMessageTx(
  account: typeof signer,
  over: Partial<MessageTxFields> & { to: Hex; nonce: bigint } & Partial<Pick<MessageTx, 'gasLimit' | 'fee'>>,
): Promise<MessageTx> {
  const { gasLimit = 100_000n, fee = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 0n }, ...rest } = over
  const f: MessageTxFields = { value: 0n, data: new Uint8Array(0), ...rest }
  const message = transactionMessage(NETWORK, f)
  const signature = (await account.signMessage({ message })) as Hex
  return { ...f, gasLimit, fee, signer: account.address.toLowerCase() as Hex, message, signature }
}

describe('Executor.applyMessageTx', () => {
  it('runs a 1559 tx from the signed fields plus unsigned gas terms, charging gas exactly like a raw tx', async () => {
    const from = signer.address.toLowerCase() as Hex
    const { overlay, executor } = setup({ [from]: 7n }, [from])
    const m = await signedMessageTx(signer, { to: TO, nonce: 7n, value: ETH / 1000n, gasLimit: 21000n })

    const { tx, changes } = await executor.applyMessageTx(m)
    overlay.commit(changes)

    expect(tx.status).toBe(1)
    expect(tx.type).toBe(2)
    // Real RLP: the tx the message describes, with the message signature as its
    // v/r/s. The hash is that tx's hash; the sender is the message signer.
    expect(tx.hash).toBe(keccak256(tx.raw))
    const parsed = parseTransaction(tx.raw)
    expect(parsed).toMatchObject({
      type: 'eip1559',
      chainId: Number(CHAIN_ID),
      nonce: 7,
      to: TO,
      value: ETH / 1000n,
      gas: 21000n,
      maxFeePerGas: 2n * GWEI,
      r: '0x' + m.signature.slice(2, 66),
      s: '0x' + m.signature.slice(66, 130),
      yParity: parseInt(m.signature.slice(130), 16) - 27,
    })
    expect(parsed.maxPriorityFeePerGas ?? 0n).toBe(0n) // viem drops a zero tip when parsing
    expect(tx.from).toBe(from)
    expect(tx.signedBy).toBe(from)
    expect(tx.to).toBe(TO)
    expect(toBigInt(tx.value)).toBe(ETH / 1000n)
    expect(toBigInt(tx.nonce)).toBe(7n)
    expect(toBigInt(tx.gasUsed)).toBe(21000n)
    expect(toBigInt(tx.gasLimit)).toBe(21000n)
    expect(toBigInt(tx.gasPrice)).toBe(2n * GWEI) // upstream quote, as for raw txs
    expect(tx.signedMessage).toEqual({ message: m.message, signature: m.signature })

    // Block baseFee is 1 gwei, cap 2 gwei, no tip: the sender pays value + 21000 * 1 gwei.
    const sender = overlay.get(addrKey(from))!
    expect(sender.balance).toBe(ETH - ETH / 1000n - 21000n * GWEI)
    expect(sender.nonce).toBe(8n)
    expect(overlay.get(addrKey(TO))!.balance).toBe(ETH / 1000n)
  })

  it('runs a legacy (gasPrice) message tx as type 0', async () => {
    const from = signer.address.toLowerCase() as Hex
    const { overlay, executor } = setup({ [from]: 0n }, [from])
    const m = await signedMessageTx(signer, { to: TO, nonce: 0n, gasLimit: 21000n, fee: { gasPrice: 3n * GWEI } })

    const { tx, changes } = await executor.applyMessageTx(m)
    overlay.commit(changes)

    expect(tx.status).toBe(1)
    expect(tx.type).toBe(0)
    expect(tx.hash).toBe(keccak256(tx.raw))
    const parsed = parseTransaction(tx.raw)
    expect(parsed).toMatchObject({ type: 'legacy', chainId: Number(CHAIN_ID), nonce: 0, gasPrice: 3n * GWEI })
    // EIP-155 v = chainId * 2 + 35 + yParity
    expect(parsed.v).toBe(CHAIN_ID * 2n + 35n + BigInt(parseInt(m.signature.slice(130), 16) - 27))
    // Legacy: gasPrice is paid in full (3 gwei) regardless of the 1 gwei baseFee.
    expect(overlay.get(addrKey(from))!.balance).toBe(ETH - 21000n * 3n * GWEI)
  })

  it('lowers the block baseFee to a fee cap below it, as for raw txs', async () => {
    const from = signer.address.toLowerCase() as Hex
    const { overlay, executor } = setup({ [from]: 0n }, [from])
    const m = await signedMessageTx(signer, {
      to: TO,
      nonce: 0n,
      gasLimit: 21000n,
      fee: { maxFeePerGas: GWEI / 10n, maxPriorityFeePerGas: 0n }, // 0.1 gwei < 1 gwei baseFee
    })
    const { tx, changes } = await executor.applyMessageTx(m)
    overlay.commit(changes)
    expect(tx.status).toBe(1)
    expect(overlay.get(addrKey(from))!.balance).toBe(ETH - 21000n * (GWEI / 10n))
  })

  it('enforces the signed nonce like a raw tx', async () => {
    const from = signer.address.toLowerCase() as Hex
    const { executor } = setup({ [from]: 7n }, [from])
    const stale = await signedMessageTx(signer, { to: TO, nonce: 6n, gasLimit: 21000n })
    await expect(executor.applyMessageTx(stale)).rejects.toThrow(/nonce/i)
    const ahead = await signedMessageTx(signer, { to: TO, nonce: 8n, gasLimit: 21000n })
    await expect(executor.applyMessageTx(ahead)).rejects.toThrow(/nonce/i)
  })

  it('fails cleanly when the sender cannot cover gas * price + value', async () => {
    const { executor } = setup({}, [])
    const m = await signedMessageTx(signer, { to: TO, nonce: 0n, value: ETH / 1000n, gasLimit: 21000n })
    await expect(executor.applyMessageTx(m)).rejects.toThrow(/insufficient|balance|funds/i)
  })

  it('carries calldata and attributes an impersonator signature to the impersonatee', async () => {
    const b = impersonator.address.toLowerCase() as Hex
    const { overlay, executor, impersonators } = setup({ [IMPERSONATEE]: 3n, [b]: 99n }, [IMPERSONATEE])
    impersonators.set(b, IMPERSONATEE)
    const data = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb, ...new Uint8Array(64).fill(1)])
    // Signed with B's nonce; under impersonation the nonce check is skipped and
    // A's own nonce advances, exactly as for an impersonated raw tx.
    const m = await signedMessageTx(impersonator, { to: TO, nonce: 99n, value: ETH / 4n, data })

    const { tx, changes } = await executor.applyMessageTx(m)
    overlay.commit(changes)

    expect(tx.status).toBe(1)
    expect(tx.from).toBe(IMPERSONATEE)
    expect(tx.signedBy).toBe(b)
    expect(toBigInt(tx.nonce)).toBe(99n) // the signed nonce (header line), as renderTx documents
    expect(tx.input).toBe('0xa9059cbb' + '01'.repeat(64))
    const a = overlay.get(addrKey(IMPERSONATEE))!
    expect(a.nonce).toBe(4n)
    expect(a.balance).toBe(ETH - ETH / 4n - toBigInt(tx.gasUsed) * GWEI)
    expect(overlay.get(addrKey(b))).toBeUndefined() // B itself untouched
  })

  it('refuses a message signed directly by a configured impersonatee', async () => {
    const a = signer.address.toLowerCase() as Hex
    const { executor, impersonators } = setup({}, [a])
    impersonators.set(impersonator.address as Hex, a)
    const m = await signedMessageTx(signer, { to: TO, nonce: 0n })
    await expect(executor.applyMessageTx(m)).rejects.toThrow(/impersonatee/)
  })
})

describe('Executor.applyTx (raw path still intact after the refactor)', () => {
  it('executes a signed 1559 transfer and charges gas', async () => {
    const from = signer.address.toLowerCase() as Hex
    const { overlay, executor } = setup({ [from]: 0n }, [from])
    const raw = await signer.signTransaction({
      chainId: Number(CHAIN_ID),
      type: 'eip1559',
      nonce: 0,
      to: TO,
      value: ETH / 1000n,
      gas: 21000n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 0n,
    })
    const { tx, changes } = await executor.applyTx(hexToBytes(raw))
    overlay.commit(changes)
    expect(tx.status).toBe(1)
    expect(tx.raw).toBe(raw)
    expect(tx.signedMessage).toBeUndefined()
    expect(tx.from).toBe(from)
    expect(toBigInt(tx.gasUsed)).toBe(21000n)
    // baseFee 1 gwei * 21000 gas debited on top of the value
    expect(overlay.get(addrKey(from))!.balance).toBe(ETH - ETH / 1000n - 21000n * 10n ** 9n)
  })
})

describe('replay guard + account kinds', () => {
  const guarded = { ...cfg, rejectUpstreamSigners: true } as Config
  const from = signer.address.toLowerCase() as Hex

  async function rawTransfer(nonce: number) {
    const raw = await signer.signTransaction({
      chainId: Number(CHAIN_ID),
      type: 'eip1559',
      nonce,
      to: TO,
      value: 1n,
      gas: 21000n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 0n,
    })
    return hexToBytes(raw)
  }

  it('an upstream-funded signer is refused raw (nothing pinned) but lands as a signed message, which pins "upstream"', async () => {
    const { executor, kinds } = setup({ [from]: 0n }, [from], { upstreamBalances: { [from]: 1n }, config: guarded })
    await expect(executor.applyTx(await rawTransfer(0))).rejects.toThrow(/EIP-191 signed message/)
    expect(kinds.peek(from)).toBeUndefined() // a refused send is not a write

    const m = await signedMessageTx(signer, { to: TO, nonce: 0n, gasLimit: 21000n })
    const res = await executor.applyMessageTx(m)
    expect(res.tx.status).toBe(1)
    expect(res.signerKind).toBe('upstream')
    expect(kinds.peek(from)).toBeUndefined() // the executor only looks up; the commit pins
    await kinds.pin(from, res.signerKind) // what the DO's commitTx does once the tx lands
    expect(kinds.peek(from)).toBe('upstream')
  })

  it('an empty signer is pinned "sandbox" by its first landed raw tx and stays accepted after it is funded upstream', async () => {
    const balances: Record<string, bigint> = {}
    const { executor, kinds, overlay } = setup({ [from]: 0n }, [from], { upstreamBalances: balances, config: guarded })
    const first = await executor.applyTx(await rawTransfer(0))
    overlay.commit(first.changes)
    expect(first.signerKind).toBe('sandbox')
    await kinds.pin(from, first.signerKind)
    expect(kinds.peek(from)).toBe('sandbox')

    balances[from] = 10n ** 18n // topped up on the real chain afterwards
    const second = await executor.applyTx(await rawTransfer(1))
    expect(second.tx.status).toBe(1) // pinned verdict: no re-check, no flip
    expect(second.signerKind).toBe('sandbox')
  })

  it('an unpinned signer that gets funded upstream between sends is refused on the next raw send', async () => {
    const balances: Record<string, bigint> = {}
    const { executor } = setup({ [from]: 0n }, [from], { upstreamBalances: balances, config: guarded })
    const first = await executor.applyTx(await rawTransfer(0))
    expect(first.signerKind).toBe('sandbox') // never pinned: pretend the commit did not happen
    balances[from] = 1n
    await expect(executor.applyTx(await rawTransfer(0))).rejects.toThrow(/upstream chain/)
  })

  it('does not classify anyone while the guard is off', async () => {
    const { executor, kinds } = setup({ [from]: 0n }, [from], { upstreamBalances: { [from]: 1n } })
    const res = await executor.applyTx(await rawTransfer(0))
    expect(res.signerKind).toBeUndefined()
    expect(kinds.peek(from)).toBeUndefined()
  })
})
