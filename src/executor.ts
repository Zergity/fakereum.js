// The EVM driver. Ports evm.go (Executor.ApplyTx / Call) onto EthereumJS v10:
//   - applyTx: decode raw tx -> recover signer -> impersonatee guard -> replay
//     guard -> impersonation rewrite (sender=A, nonce forced) -> baseFee-lower
//     -> execute.
//   - applyMessageTx: an EIP-191 signed-message tx (lib/eip191.ts) -> the
//     legacy/1559 tx it describes, carrying the message signature as its v/r/s,
//     sender = recovered signer -> impersonation rewrite -> baseFee-lower ->
//     execute (no replay guard: nothing to replay).
//   - execute (shared): prefetch -> runTx with an ecrecover precompile swap ->
//     capture diff -> return the overlay WorkingChange set + the StoredTx
//     (caller commits/persists).
//   - call: read-only runCall for local-mode eth_call / eth_estimateGas with
//     ephemeral state overrides.

import { createVM, runTx, type VM } from '@ethereumjs/vm'
import { createEVM } from '@ethereumjs/evm'
import type { CustomPrecompile, PrecompileInput, ExecResult } from '@ethereumjs/evm'
import { createFeeMarket1559Tx, createLegacyTx, createTxFromRLP } from '@ethereumjs/tx'
import { createBlock } from '@ethereumjs/block'
import {
  Address,
  createAddressFromString,
  bytesToHex as ejBytesToHex,
  setLengthLeft,
} from '@ethereumjs/util'
import { Common, Hardfork, Mainnet, createCustomCommon } from '@ethereumjs/common'
import { recoverAddress } from 'viem'

import type { Config, DeployMethod, SignedMessage, StoredLog, StoredTx, TxDiff } from './types'
import type { Overlay, WorkingChange } from './overlay'
import { MissRecorder, type BlockCtx, type Fetcher } from './fetcher'
import { ForkingStateManager } from './statemanager'
import { headTime } from './head'
import type { Impersonators } from './impersonate/store'
import { rejectUpstreamSignersEnabled } from './config'
import { decodeRevertReason } from './ui/decode'
import type { MessageTxFields } from './lib/eip191'
import { isLegacyFee, type MessageTxFee } from './message_tx'
import type { AccountKind, AccountKinds } from './account_kind'
import { addrKey, bytesToHex, checksumAddress, hexToBytes, toQuantity, type Hex } from './lib/hex'

const ECRECOVER_GAS = 3000n
const ECRECOVER_ADDR = '0x0000000000000000000000000000000000000001'

// Sender balance forced into the access-list simulation override: ample for
// any gas*price+value, far below anything that could overflow u256 math.
const PREFETCH_SENDER_BALANCE = '0xffffffffffffffffffffffffff'

// Speculative warm-up rounds cap. Each round that finds new misses costs one
// batch POST; the converging round costs zero. Rounds grow the fetched set by
// at least one data-dependent hop, so real txs converge in 1-3.
const MAX_WARM_ROUNDS = 6

export interface ApplyResult {
  tx: StoredTx
  changes: WorkingChange[]
  /**
   * The signer's account kind as looked up for this tx (replay guard on only).
   * The caller pins it once the tx lands — see account_kind.ts.
   */
  signerKind?: AccountKind
}

/** An EIP-191 signed-message transaction, already verified (see message_tx.ts). */
export interface MessageTx extends MessageTxFields {
  /** Recovered signer of `signature`. */
  signer: Hex
  message: string
  signature: Hex
  /** Unsigned gas terms, from the params or wallet-style defaults. */
  gasLimit: bigint
  fee: MessageTxFee
}

type RunnableTx = Parameters<typeof runTx>[1]['tx']
type SenderOverridable = { getSenderAddress: () => Address }

interface ExecParams {
  tx: RunnableTx
  block: BlockCtx
  baseFee: bigint
  /** Effective sender (impersonatee A when impersonated). */
  fromHex: Hex
  /** Physical signer. */
  signerHex: Hex
  skipNonce: boolean
  hash: Hex
  raw: Hex
  signedMessage?: SignedMessage
  signerKind?: AccountKind
}

export interface CallArgs {
  from?: Hex
  to?: Hex | null
  gas?: bigint
  gasPrice?: bigint
  value?: bigint
  data?: Hex
}

export interface CallResult {
  returnData: Hex
  executionGasUsed: bigint
  intrinsicGas: bigint
  error?: string
}

export interface AccountOverride {
  balance?: bigint
  nonce?: bigint
  code?: Uint8Array
  state?: Map<string, Uint8Array>
  stateDiff?: Map<string, Uint8Array>
}

export class Executor {
  private common: Common

  constructor(
    private readonly overlay: Overlay,
    private readonly fetcher: Fetcher,
    private readonly cfg: Config,
    private readonly impersonators: Impersonators,
    private readonly kinds: AccountKinds,
  ) {
    // Pin to Cancun (matches the Go config's explicit Shanghai+Cancun forks) with
    // the sandbox chain id bound for tx recovery. Cancun keeps block-header
    // requirements minimal for the synthetic sandbox tip. To capture EIP-7702
    // setCode deploys, switch this to Hardfork.Prague (and ensure the synthetic
    // block in buildBlock carries the Prague-required header fields).
    this.common = createCustomCommon({ chainId: Number(cfg.chainId) }, Mainnet, {
      hardfork: Hardfork.Cancun,
    })
  }

  // --- sandbox tx execution ----------------------------------------------

  async applyTx(rawTx: Uint8Array): Promise<ApplyResult> {
    // freeze:false so we can override getSenderAddress for impersonation.
    const tx = createTxFromRLP(rawTx, { common: this.common, freeze: false })
    const signer = tx.getSenderAddress()
    const signerHex = ejBytesToHex(signer.bytes) as Hex

    this.assertNotImpersonatee(signerHex)

    // Replay guard: reject signers of the 'upstream' kind (funded on the real
    // chain; pinned by their first landed tx — see account_kind.ts).
    let signerKind: AccountKind | undefined
    if (rejectUpstreamSignersEnabled(this.cfg)) {
      signerKind = (await this.kinds.lookup(signerHex)).kind
      if (signerKind === 'upstream') {
        throw new Error(
          `signer ${signerHex} holds a native balance on the upstream chain (chain id ${this.cfg.chainId}); refusing to execute because this transaction could be replayed onto the real chain. Send it as an EIP-191 signed message (fakereum_sendTransaction) instead, or sign from a wallet funded only with Fake Native Token (zero upstream balance)`,
        )
      }
    }

    // Impersonation: sender becomes A; nonce forced to A's chain nonce.
    const fromHex = this.impersonateSender(tx, signerHex)
    const impersonated = fromHex !== signerHex

    const block = await this.liveBlock()

    // baseFee-lowering: if the signed maxFeePerGas is below the upstream
    // baseFee, lower the block baseFee to the cap so the tx still lands.
    let baseFee = block.baseFee
    const feeCap = txMaxFee(tx)
    if (feeCap !== null && feeCap > 0n && baseFee > feeCap) baseFee = feeCap

    return this.execute({
      tx,
      block,
      baseFee,
      fromHex,
      signerHex,
      skipNonce: impersonated, // impersonation forces A's nonce; skip the equality check
      hash: bytesToHex(tx.hash()),
      raw: bytesToHex(rawTx),
      signerKind,
    })
  }

  /**
   * Execute an EIP-191 signed-message transaction (lib/eip191.ts). The message
   * binds nonce, to, value and data; gas limit and fee terms come unsigned from
   * the params. This builds the corresponding legacy or EIP-1559 tx carrying
   * the message signature's r/s/v as its own signature fields — so it has real
   * RLP bytes and a real tx hash — attributes it to the recovered signer (the
   * tx-level recovery would yield a stranger, since the signature covers the
   * message, not the tx) and runs it through the same path as a raw tx: same
   * nonce/balance checks, same baseFee-lowering, same fee accounting, same
   * impersonation NAT. Only the replay guard is skipped: a personal_sign message
   * can't be broadcast as a tx on any chain, so there is nothing to replay.
   */
  async applyMessageTx(m: MessageTx): Promise<ApplyResult> {
    const signerHex = m.signer.toLowerCase() as Hex
    this.assertNotImpersonatee(signerHex)
    // No guard here, but a landed tx pins the signer's kind like any write;
    // look it up now so the caller can pin without a second upstream read.
    const signerKind = rejectUpstreamSignersEnabled(this.cfg)
      ? (await this.kinds.lookup(signerHex)).kind
      : undefined

    const { r, s, yParity } = splitSignature(m.signature)
    // No `to` = contract creation; the data is the init code.
    const base = { nonce: m.nonce, to: m.to ?? undefined, value: m.value, data: m.data, gasLimit: m.gasLimit, r, s }
    const opts = { common: this.common, freeze: false }
    const tx: RunnableTx = isLegacyFee(m.fee)
      ? createLegacyTx(
          { ...base, gasPrice: m.fee.gasPrice, v: this.cfg.chainId * 2n + 35n + yParity }, // EIP-155 v
          opts,
        )
      : createFeeMarket1559Tx(
          {
            ...base,
            chainId: this.cfg.chainId,
            maxFeePerGas: m.fee.maxFeePerGas,
            maxPriorityFeePerGas: m.fee.maxPriorityFeePerGas,
            v: yParity,
          },
          opts,
        )
    forceSender(tx, signerHex)
    const fromHex = this.impersonateSender(tx, signerHex)
    const impersonated = fromHex !== signerHex

    const block = await this.liveBlock()
    let baseFee = block.baseFee
    const feeCap = txMaxFee(tx)
    if (feeCap !== null && feeCap > 0n && baseFee > feeCap) baseFee = feeCap

    return this.execute({
      tx,
      block,
      baseFee,
      fromHex,
      signerHex,
      skipNonce: impersonated,
      hash: bytesToHex(tx.hash()),
      raw: bytesToHex(tx.serialize()),
      signedMessage: { message: m.message, signature: m.signature },
      signerKind,
    })
  }

  /**
   * Shared execution core: warm the fetcher cache, run the tx against a fork
   * of overlay+upstream, and package the diff + receipt into a StoredTx. The
   * caller has already decided the sender, the block baseFee and the hash.
   */
  private async execute(p: ExecParams): Promise<ApplyResult> {
    const { tx, block, baseFee, fromHex, signerHex } = p

    // Warm the fetcher cache for everything this tx is likely to touch, in 2-3
    // batched subrequests, before the lazy fork starts issuing per-read
    // fetches (3 per cold account + 1 per cold SLOAD — enough to blow the Free
    // plan's 50-subrequest cap on a heavy tx).
    await this.prefetchTouchedState(
      fromHex,
      tx.to ? (ejBytesToHex(tx.to.bytes) as Hex) : null,
      tx.data,
      tx.gasLimit,
      tx.value,
      block.coinbase,
    )

    const ejBlock = this.buildBlock(block, baseFee)
    const customPrecompiles = this.impersonators.isEmpty() ? undefined : [this.ecrecoverPrecompile()]

    // Backstop for whatever the access-list prefetch missed (its upstream
    // simulation can diverge from sandbox execution, or be refused outright):
    // speculatively run the tx against the cache alone, batch-fetch every
    // recorded miss, and repeat until a run completes fully warm. Costs one
    // batch POST per round instead of one fetch per cold read.
    await this.warmupRounds(tx, ejBlock, customPrecompiles)

    const sm = new ForkingStateManager(this.overlay, this.fetcher)
    const vm: VM = await createVM({
      common: this.common,
      stateManager: sm,
      ...(customPrecompiles ? { evmOpts: { customPrecompiles } } : {}),
    })

    // Watch the EVM message stream to record HOW each contract is deployed
    // (zero-address tx / CREATE / CREATE2). The diff only tells us THAT code
    // appeared; the opcode is only visible on the live message.
    const deployVia = captureDeployMethods(vm)

    const res = await runTx(vm, {
      tx,
      block: ejBlock,
      skipNonce: p.skipNonce,
      skipHardForkValidation: true,
    })

    const status: 0 | 1 = res.execResult.exceptionError ? 0 : 1
    const returnData = res.execResult.returnValue ?? new Uint8Array(0)
    const { diff, changes } = sm.collectChanges()

    const hash = p.hash
    const gasPrice = await this.effectiveGasPrice(tx)
    const logs: StoredLog[] = (res.execResult.logs ?? []).map((l) =>
      toStoredLog(l, block.number, block.hash, hash),
    )

    const createdContracts = deriveCreatedContracts(diff)
    let contractAddress: Hex | null = null
    if (tx.to === undefined && res.createdAddress) {
      contractAddress = ejBytesToHex(res.createdAddress.bytes) as Hex
    }

    // Annotate only the contracts that actually landed in the diff (drops any
    // create that reverted after its address was generated). Keyed by addrKey,
    // matching diff.accounts / createdContracts keys.
    let createdVia: Record<string, DeployMethod> | undefined
    for (const c of createdContracts) {
      const k = addrKey(c)
      const method = deployVia.get(k)
      if (!method) continue
      ;(createdVia ??= {})[k] = method
    }

    const stored: StoredTx = {
      hash,
      raw: p.raw,
      type: tx.type,
      from: fromHex,
      signedBy: signerHex,
      to: tx.to ? (ejBytesToHex(tx.to.bytes) as Hex) : null,
      nonce: toQuantity(tx.nonce),
      value: toQuantity(tx.value),
      input: bytesToHex(tx.data),
      gasLimit: toQuantity(tx.gasLimit),
      gasUsed: toQuantity(res.totalGasSpent),
      gasPrice,
      status,
      contractAddress,
      createdContracts,
      ...(createdVia ? { createdVia } : {}),
      logs,
      blockNumber: toQuantity(block.number),
      blockHash: block.hash,
      blockTime: toQuantity(block.time),
      seq: 0, // assigned by Sandbox.store
      ...(p.signedMessage ? { signedMessage: p.signedMessage } : {}),
      diff,
    }
    if (status === 0) {
      const err = res.execResult.exceptionError
      stored.err = err ? String(err.error ?? err) : 'execution failed'
      const reason = safeDecodeRevert(bytesToHex(returnData))
      if (reason) stored.revertReason = reason
    }

    return { tx: stored, changes, ...(p.signerKind ? { signerKind: p.signerKind } : {}) }
  }

  /**
   * Impersonatee guard: a configured impersonatee A must be driven via its
   * impersonator key B, never sign directly. Checked ahead of the replay guard.
   */
  private assertNotImpersonatee(signerHex: Hex): void {
    if (this.impersonators.isImpersonatee(signerHex)) {
      throw new Error(
        `signer ${signerHex} is configured as an impersonatee; act on it through its impersonator key (sign with B), not by signing as A directly`,
      )
    }
  }

  /** Map signer B to impersonatee A (overriding the tx's sender); returns the effective sender. */
  private impersonateSender(tx: SenderOverridable, signerHex: Hex): Hex {
    const mappedA = this.impersonators.resolve(signerHex)
    if (mappedA === null) return signerHex
    forceSender(tx, mappedA)
    return mappedA
  }

  /**
   * Always fetch the live tip (uncached): the executed tx must see the true
   * current block.number, not a value cached up to ttlMs ago. Its timestamp
   * is the head clock (see head.ts): wall clock, never behind the upstream
   * header — a lagging node or a chain idle between txs must not hand the tx
   * a stopped block.timestamp.
   */
  private async liveBlock(): Promise<BlockCtx> {
    const tip = await this.fetcher.getLatestBlockUncached()
    return { ...tip, time: headTime(tip.time) }
  }

  /**
   * Speculative warm-up: run the tx on a throwaway VM whose reads come from
   * the cache only (MissRecorder answers zero for anything cold and records
   * it), then batch-fetch the whole recorded set in one POST and run again.
   * A zero guess can steer a round down a wrong branch; the next round holds
   * the true values and goes deeper, so the recorded set grows monotonically
   * until a round finishes with no misses (typical: 1-3 rounds; the round
   * that confirms convergence costs zero subrequests). Stops early when a
   * round finds nothing new (e.g. reads that keep failing upstream) and caps
   * at MAX_WARM_ROUNDS; anything still cold falls back to the lazy per-read
   * path in the real run, which remains the source of correctness.
   */
  private async warmupRounds(
    tx: Parameters<typeof runTx>[1]['tx'],
    ejBlock: Parameters<typeof runTx>[1]['block'],
    customPrecompiles: CustomPrecompile[] | undefined,
  ): Promise<void> {
    const fetched = new Set<string>()
    for (let round = 0; round < MAX_WARM_ROUNDS; round++) {
      const rec = new MissRecorder(this.fetcher)
      const sm = new ForkingStateManager(this.overlay, rec)
      const vm: VM = await createVM({
        common: this.common,
        stateManager: sm,
        ...(customPrecompiles ? { evmOpts: { customPrecompiles } } : {}),
      })
      try {
        await runTx(vm, {
          tx,
          block: ejBlock,
          // Sender balance/nonce may still be zero-guesses; let the run reach
          // the EVM anyway — the real run re-validates against true values.
          skipNonce: true,
          skipBalance: true,
          skipHardForkValidation: true,
        })
      } catch {
        // a speculative run may die on wrong guesses; its misses still count
      }
      let progress = false
      for (const k of rec.keys) {
        if (!fetched.has(k)) {
          fetched.add(k)
          progress = true
        }
      }
      if (!progress) return // converged, or the remaining misses won't fetch
      try {
        await this.fetcher.prefetchState([...rec.accounts], rec.slots)
      } catch {
        return // upstream unwell — the real run surfaces the actual error
      }
    }
  }

  /**
   * Best-effort cache warm-up: ask upstream for the call's access list (one
   * subrequest), then batch-fetch every listed account + slot (one subrequest
   * per 100 reads). The simulation runs with the sandbox overlay attached as
   * state overrides and the sender's balance forced high (sandbox funds live
   * only in the overlay; forcing it also keeps rare BALANCE(sender)-reading
   * paths approximate rather than exact), so the traced path tracks SANDBOX
   * execution closely. Whatever still diverges falls through to the existing
   * lazy per-read fetch, which stays the source of correctness.
   */
  private async prefetchTouchedState(
    from: Hex,
    to: Hex | null,
    data: Uint8Array,
    gasLimit: bigint,
    value: bigint,
    coinbase?: Hex,
  ): Promise<void> {
    try {
      const call: Record<string, unknown> = {
        from,
        data: bytesToHex(data),
        value: toQuantity(value),
      }
      if (to) call['to'] = to
      if (gasLimit > 0n) call['gas'] = toQuantity(gasLimit)
      const overrides = this.overlay.asStateOverrides() as Record<string, Record<string, unknown>>
      const senderKey =
        Object.keys(overrides).find((k) => k.toLowerCase() === from.toLowerCase()) ??
        checksumAddress(from)
      overrides[senderKey] = { ...(overrides[senderKey] ?? {}), balance: PREFETCH_SENDER_BALANCE }
      const list = await this.fetcher.createAccessList(call, overrides)
      const accounts = new Set<Hex>([from.toLowerCase() as Hex])
      if (to) accounts.add(to.toLowerCase() as Hex)
      if (coinbase) accounts.add(coinbase.toLowerCase() as Hex)
      const slots: Array<[Hex, Hex]> = []
      if (list) {
        for (const e of list) {
          if (!e || typeof e.address !== 'string') continue
          const a = e.address.toLowerCase() as Hex
          accounts.add(a)
          if (Array.isArray(e.storageKeys)) {
            for (const k of e.storageKeys) if (typeof k === 'string') slots.push([a, k as Hex])
          }
        }
      }
      await this.fetcher.prefetchState([...accounts], slots)
    } catch {
      // best-effort only — every miss is covered by the lazy per-read path
    }
  }

  // --- read-only call (local mode eth_call / eth_estimateGas) -------------

  async call(args: CallArgs, overrides: Map<string, AccountOverride> | null): Promise<CallResult> {
    const block = await this.fetcher.getLatestBlock()
    // Same batched warm-up as applyTx — in getStorageAt mode every local
    // eth_call otherwise pays 3 singles per cold account + 1 per cold SLOAD.
    await this.prefetchTouchedState(
      args.from ?? (ZERO_ADDR as Hex),
      args.to ?? null,
      args.data ? hexToBytes(args.data) : new Uint8Array(0),
      args.gas ?? 0n,
      args.value ?? 0n,
    )
    const sm = new ForkingStateManager(this.overlay, this.fetcher)
    if (overrides) {
      for (const [k, o] of overrides) {
        await sm.applyOverride(createAddressFromString(k.toLowerCase()), o)
      }
    }
    const evm = await createEVM({ common: this.common, stateManager: sm })

    const data = args.data ? hexToBytes(args.data) : new Uint8Array(0)
    const isCreate = !args.to
    const gasLimit = args.gas && args.gas > 0n ? args.gas : block.gasLimit

    // Give the call a block context so TIMESTAMP/NUMBER read sensibly instead of
    // the EVM's default zero-block. block.timestamp is the head clock (head.ts):
    // the upstream latest-block time can be stale (cached up to cacheTtlMs, a
    // lagging node, an idle chain) and callers reading block.timestamp expect
    // "now". Everything else mirrors the latest block.
    const ejBlock = this.buildBlock({ ...block, time: headTime(block.time) }, block.baseFee)

    const res = await evm.runCall({
      caller: args.from ? createAddressFromString(args.from.toLowerCase()) : createAddressFromString(ZERO_ADDR),
      to: args.to ? createAddressFromString(args.to.toLowerCase()) : undefined,
      data,
      gasLimit,
      value: args.value ?? 0n,
      gasPrice: 0n,
      skipBalance: true,
      block: ejBlock,
    })

    const out: CallResult = {
      returnData: bytesToHex(res.execResult.returnValue ?? new Uint8Array(0)),
      executionGasUsed: res.execResult.executionGasUsed,
      intrinsicGas: intrinsicGas(data, isCreate),
    }
    if (res.execResult.exceptionError) {
      out.error = String(res.execResult.exceptionError.error ?? res.execResult.exceptionError)
    }
    return out
  }

  // --- helpers ------------------------------------------------------------

  private buildBlock(
    block: { number: bigint; time: bigint; gasLimit: bigint; coinbase: Hex; difficulty: bigint; mixHash: Hex },
    baseFee: bigint,
  ) {
    return createBlock(
      {
        header: {
          number: block.number,
          timestamp: block.time,
          gasLimit: block.gasLimit,
          baseFeePerGas: baseFee,
          coinbase: createAddressFromString(block.coinbase.toLowerCase()),
          difficulty: block.difficulty,
          mixHash: hexToBytes(block.mixHash),
          // Cancun+ requires blob fields + the 4788 beacon-root; zero is fine
          // for the synthetic sandbox tip.
          excessBlobGas: 0n,
          blobGasUsed: 0n,
          parentBeaconBlockRoot: new Uint8Array(32),
        },
      },
      { common: this.common, skipConsensusFormatValidation: true },
    )
  }

  /** Effective gas price for the receipt: upstream quote, else the tx's cap. */
  private async effectiveGasPrice(tx: {
    type: number
    gasPrice?: bigint
    maxFeePerGas?: bigint
  }): Promise<Hex> {
    try {
      const q = await this.fetcher.gasPrice()
      if (q > 0n) return toQuantity(q)
    } catch {
      /* fall through to the signed cap */
    }
    const cap =
      tx.type <= 1
        ? (tx.gasPrice ?? 0n) // legacy / 2930
        : ((tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? 0n) // 1559 / 4844 / 7702
    return toQuantity(cap)
  }

  /** Custom ecrecover (0x01) that remaps a recovered impersonator B to A. */
  private ecrecoverPrecompile(): CustomPrecompile {
    const im = this.impersonators
    return {
      address: ECRECOVER_ADDR,
      function: async (input: PrecompileInput): Promise<ExecResult> => {
        const data = input.data
        if (input.gasLimit < ECRECOVER_GAS) {
          return { executionGasUsed: input.gasLimit, returnValue: new Uint8Array(0) }
        }
        const buf = new Uint8Array(128)
        buf.set(data.subarray(0, Math.min(128, data.length)))
        // v lives in the last byte of word 2; words must be otherwise zero.
        let vOk = true
        for (let i = 32; i < 63; i++) if (buf[i] !== 0) vOk = false
        const v = buf[63]!
        if (!vOk || (v !== 27 && v !== 28)) {
          return { executionGasUsed: ECRECOVER_GAS, returnValue: new Uint8Array(0) }
        }
        const hashHex = bytesToHex(buf.subarray(0, 32))
        const sig = bytesToHex(
          concat3(buf.subarray(64, 96), buf.subarray(96, 128), Uint8Array.from([v])),
        )
        try {
          const recovered = (await recoverAddress({
            hash: hashHex,
            signature: sig as Hex,
          })) as Hex
          const mapped = im.resolve(recovered) ?? recovered
          return { executionGasUsed: ECRECOVER_GAS, returnValue: setLengthLeft(hexToBytes(mapped), 32) }
        } catch {
          return { executionGasUsed: ECRECOVER_GAS, returnValue: new Uint8Array(0) }
        }
      },
    }
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

/** r, s and the recovery bit of a 65-byte r||s||v signature (v in {0,1,27,28}). */
function splitSignature(sig: Hex): { r: bigint; s: bigint; yParity: bigint } {
  const b = hexToBytes(sig)
  if (b.length !== 65) throw new Error(`expected 65-byte signature, got ${b.length}`)
  const v = b[64]!
  const yParity = v >= 27 ? v - 27 : v
  if (yParity !== 0 && yParity !== 1) throw new Error(`invalid signature v ${v}`)
  return {
    r: BigInt(bytesToHex(b.subarray(0, 32))),
    s: BigInt(bytesToHex(b.subarray(32, 64))),
    yParity: BigInt(yParity),
  }
}

/** Make the tx report `addr` as its sender regardless of what v/r/s recover to. */
function forceSender(tx: SenderOverridable, addr: Hex): void {
  const a = createAddressFromString(addr.toLowerCase())
  tx.getSenderAddress = () => a
}

function txMaxFee(tx: { type: number; maxFeePerGas?: bigint; gasPrice?: bigint }): bigint | null {
  if (tx.type <= 1) return tx.gasPrice ?? null // legacy / 2930
  return (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? null // 1559 / 4844 / 7702
}

/**
 * Classify a contract-creation message. Called at `beforeMessage`, where a
 * create has no `to` yet and `salt` is set only for the CREATE2 opcode; depth 0
 * is the top-level (zero-`to`) transaction, which is always a plain CREATE.
 */
export function classifyDeploy(depth: number, hasSalt: boolean): DeployMethod {
  if (hasSalt) return 'create2'
  return depth === 0 ? 'tx' : 'create'
}

/**
 * Attach listeners to the EVM message stream and return a map (addrKey ->
 * method) of every contract created during the run. `beforeMessage` fires for a
 * create with `message.to` still undefined (and `salt` present only for
 * CREATE2); the very next `newContract` event carries the generated address —
 * no other create can interleave between the two, so a single "pending" slot
 * correlates them safely.
 */
export function captureDeployMethods(vm: VM): Map<string, DeployMethod> {
  const out = new Map<string, DeployMethod>()
  const events = vm.evm.events
  if (!events) return out

  let pending: DeployMethod | null = null
  events.on('beforeMessage', (msg) => {
    // A create message has no recipient yet; a call always has `to` set.
    pending = msg.to === undefined || msg.to === null ? classifyDeploy(msg.depth, msg.salt !== undefined) : null
  })
  events.on('newContract', (data) => {
    if (pending === null) return
    out.set(ejBytesToHex(data.address.bytes).toLowerCase(), pending)
    pending = null
  })
  return out
}

function deriveCreatedContracts(diff: TxDiff): Hex[] {
  const out: Hex[] = []
  for (const [key, ad] of Object.entries(diff.accounts)) {
    if (ad.codeChanged && ad.postCode && ad.postCode !== '0x' && (!ad.preCode || ad.preCode === '0x')) {
      out.push(('0x' + key.slice(2)) as Hex)
    }
  }
  return out
}

function toStoredLog(
  l: [Uint8Array, Uint8Array[], Uint8Array],
  blockNumber: bigint,
  blockHash: Hex,
  txHash: Hex,
): StoredLog {
  return {
    address: bytesToHex(l[0]),
    topics: l[1].map((t) => bytesToHex(t)),
    data: bytesToHex(l[2]),
    blockNumber: toQuantity(blockNumber),
    blockHash,
    transactionHash: txHash,
    transactionIndex: '0x0',
    logIndex: '0x0', // assigned by Sandbox.store
    removed: false,
  }
}

function safeDecodeRevert(returnData: Hex): string | null {
  try {
    return decodeRevertReason(returnData)
  } catch {
    return null
  }
}

/** EIP-2028 intrinsic gas for a message (used only for local-mode estimateGas). */
function intrinsicGas(data: Uint8Array, isCreate: boolean): bigint {
  let gas = 21000n
  if (isCreate) gas += 32000n
  for (const b of data) gas += b === 0 ? 4n : 16n
  if (isCreate) {
    const words = BigInt(Math.ceil(data.length / 32))
    gas += words * 2n // EIP-3860 initcode word cost
  }
  return gas
}

function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length)
  out.set(a, 0)
  out.set(b, a.length)
  out.set(c, a.length + b.length)
  return out
}
