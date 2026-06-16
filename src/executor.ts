// The EVM driver. Ports evm.go (Executor.ApplyTx / Call) onto EthereumJS v10:
//   - ApplyTx: decode raw tx -> recover signer -> impersonatee guard -> replay
//     guard -> impersonation rewrite (sender=A, nonce forced) -> baseFee-lower
//     -> runTx with an ecrecover precompile swap -> capture diff -> return the
//     overlay WorkingChange set + the StoredTx (caller commits/persists).
//   - call: read-only runCall for local-mode eth_call / eth_estimateGas with
//     ephemeral state overrides.

import { createVM, runTx, type VM } from '@ethereumjs/vm'
import { createEVM } from '@ethereumjs/evm'
import type { CustomPrecompile, PrecompileInput, ExecResult } from '@ethereumjs/evm'
import { createTxFromRLP } from '@ethereumjs/tx'
import { createBlock } from '@ethereumjs/block'
import {
  Account,
  Address,
  createAddressFromString,
  bytesToHex as ejBytesToHex,
  setLengthLeft,
} from '@ethereumjs/util'
import { Common, Hardfork, Mainnet, createCustomCommon } from '@ethereumjs/common'
import { recoverAddress } from 'viem'

import type { Config, StoredLog, StoredTx, TxDiff } from './types'
import type { Overlay, WorkingChange } from './overlay'
import type { Fetcher } from './fetcher'
import { ForkingStateManager } from './statemanager'
import type { Impersonators } from './impersonate/store'
import { rejectUpstreamSignersEnabled } from './config'
import { decodeRevertReason } from './ui/decode'
import { addrKey, bytesToHex, hexToBytes, toBigInt, toQuantity, type Hex } from './lib/hex'

const ECRECOVER_GAS = 3000n
const ECRECOVER_ADDR = '0x0000000000000000000000000000000000000001'

export interface ApplyResult {
  tx: StoredTx
  changes: WorkingChange[]
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
  private guardVerdict = new Map<string, boolean>()

  constructor(
    private readonly overlay: Overlay,
    private readonly fetcher: Fetcher,
    private readonly cfg: Config,
    private readonly impersonators: Impersonators,
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

    // Impersonatee guard: a configured impersonatee A must be driven via its
    // impersonator key B, never sign directly. Checked ahead of the replay guard.
    if (this.impersonators.isImpersonatee(signerHex)) {
      throw new Error(
        `signer ${signerHex} is configured as an impersonatee; act on it through its impersonator key (sign with B), not by signing as A directly`,
      )
    }

    // Replay guard: reject signers holding real upstream balance (memoized once).
    if (rejectUpstreamSignersEnabled(this.cfg)) {
      const allowed = await this.signerCleared(signerHex)
      if (!allowed) {
        throw new Error(
          `signer ${signerHex} holds a native balance on the upstream chain (chain id ${this.cfg.chainId}); refusing to execute because this transaction could be replayed onto the real chain. Sign from a wallet funded only with Fake Native Token (zero upstream balance)`,
        )
      }
    }

    // Impersonation: sender becomes A; nonce forced to A's chain nonce.
    const mappedA = this.impersonators.resolve(signerHex)
    const impersonated = mappedA !== null
    let fromHex = signerHex
    if (impersonated) {
      fromHex = mappedA!
      const aAddr = createAddressFromString(mappedA!.toLowerCase())
      ;(tx as unknown as { getSenderAddress: () => Address }).getSenderAddress = () => aAddr
    }

    const block = await this.fetcher.getLatestBlock()

    // baseFee-lowering: if the signed maxFeePerGas is below the upstream
    // baseFee, lower the block baseFee to the cap so the tx still lands.
    let baseFee = block.baseFee
    const feeCap = txMaxFee(tx)
    if (feeCap !== null && feeCap > 0n && baseFee > feeCap) baseFee = feeCap

    const sm = new ForkingStateManager(this.overlay, this.fetcher)
    const ejBlock = this.buildBlock(block, baseFee)
    const customPrecompiles = this.impersonators.isEmpty() ? undefined : [this.ecrecoverPrecompile()]
    const vm: VM = await createVM({
      common: this.common,
      stateManager: sm,
      ...(customPrecompiles ? { evmOpts: { customPrecompiles } } : {}),
    })

    const res = await runTx(vm, {
      tx,
      block: ejBlock,
      skipNonce: impersonated, // impersonation forces A's nonce; skip the equality check
      skipHardForkValidation: true,
    })

    const status: 0 | 1 = res.execResult.exceptionError ? 0 : 1
    const returnData = res.execResult.returnValue ?? new Uint8Array(0)
    const { diff, changes } = sm.collectChanges()

    const hash = bytesToHex(tx.hash())
    const gasPrice = await this.effectiveGasPrice(tx)
    const logs: StoredLog[] = (res.execResult.logs ?? []).map((l) =>
      toStoredLog(l, block.number, block.hash, hash),
    )

    const createdContracts = deriveCreatedContracts(diff)
    let contractAddress: Hex | null = null
    if (tx.to === undefined && res.createdAddress) {
      contractAddress = ejBytesToHex(res.createdAddress.bytes) as Hex
    }

    const stored: StoredTx = {
      hash,
      raw: bytesToHex(rawTx),
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
      logs,
      blockNumber: toQuantity(block.number),
      blockHash: block.hash,
      blockTime: toQuantity(block.time),
      seq: 0, // assigned by Sandbox.store
      diff,
    }
    if (status === 0) {
      const err = res.execResult.exceptionError
      stored.err = err ? String(err.error ?? err) : 'execution failed'
      const reason = safeDecodeRevert(bytesToHex(returnData))
      if (reason) stored.revertReason = reason
    }

    return { tx: stored, changes }
  }

  private async signerCleared(signerHex: Hex): Promise<boolean> {
    const k = addrKey(signerHex)
    const memo = this.guardVerdict.get(k)
    if (memo !== undefined) return memo
    const bal = await this.fetcher.getBalanceUncached(signerHex)
    const allowed = bal === 0n
    this.guardVerdict.set(k, allowed)
    return allowed
  }

  // --- read-only call (local mode eth_call / eth_estimateGas) -------------

  async call(args: CallArgs, overrides: Map<string, AccountOverride> | null): Promise<CallResult> {
    const block = await this.fetcher.getLatestBlock()
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

    const res = await evm.runCall({
      caller: args.from ? createAddressFromString(args.from.toLowerCase()) : createAddressFromString(ZERO_ADDR),
      to: args.to ? createAddressFromString(args.to.toLowerCase()) : undefined,
      data,
      gasLimit,
      value: args.value ?? 0n,
      gasPrice: 0n,
      skipBalance: true,
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

function txMaxFee(tx: { type: number; maxFeePerGas?: bigint; gasPrice?: bigint }): bigint | null {
  if (tx.type <= 1) return tx.gasPrice ?? null // legacy / 2930
  return (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? null // 1559 / 4844 / 7702
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
