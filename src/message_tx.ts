// The two JSON-RPC methods behind EIP-191 signed-message transactions
// (verification half; execution/persistence are injected by the DO):
//
//   fakereum_transactionMessage [{from?, to, value?, data?, nonce?}]
//     -> { message, nonce }   the exact text to hand to personal_sign; nonce
//                             read from the sandbox when omitted (needs from)
//   fakereum_sendTransaction    [{to, value?, data?, nonce, gas?, gasPrice? | maxFeePerGas?, maxPriorityFeePerGas?, signature}]
//     -> tx hash              rebuilds the text, recovers the signer, executes
//
// Field names and encodings follow eth_sendTransaction: numbers are 0x-hex
// quantities, `data` is 0x-hex bytes; omit `to` for a contract creation (the
// data is then the init code). The signature covers nonce, to, value
// and data (see lib/eip191.ts). Gas limit and fee terms are not signed — they
// are taken from the params and defaulted like a wallet would (gas from the
// local estimate, fee = upstream gas price as an EIP-1559 cap, no tip). A
// wallet won't relay fakereum_* methods, so a dapp POSTs these straight to the
// sandbox RPC URL it read from discovery.

import type { Config } from './types'
import { ERR_INVALID_PARAMS, ERR_SERVER, makeError, makeResult, type RpcRequest, type RpcResponse } from './rpc'
import { bytesToHex, hexToBytes, isHex, toAddress, toBigInt, toQuantity, type Hex } from './lib/hex'
import { messageChainName, recoverMessageSigner, transactionMessage, type MessageTxFields } from './lib/eip191'

const HEX_BYTES_RE = /^0x([0-9a-fA-F]{2})*$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const QUANTITY_RE = /^0x[0-9a-fA-F]+$/

/** Legacy (type 0) fee terms. */
export interface LegacyFee {
  gasPrice: bigint
}
/** EIP-1559 (type 2) fee terms. */
export interface FeeMarketFee {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}
export type MessageTxFee = LegacyFee | FeeMarketFee

export function isLegacyFee(f: MessageTxFee): f is LegacyFee {
  return 'gasPrice' in f
}

/** A verified message tx, ready for the executor: signed fields + unsigned gas terms. */
export interface MessageTxRequest extends MessageTxFields {
  /** Recovered EIP-191 signer (lowercase). */
  signer: Hex
  message: string
  signature: Hex
  gasLimit: bigint
  fee: MessageTxFee
}

/** Sandbox-aware lookups both methods use to fill omitted fields. */
export interface MessageTxDeps {
  nonce: (from: Hex) => Promise<bigint>
  /** `to` is absent for a contract creation. */
  estimateGas: (call: { from: Hex; to?: Hex; value: Hex; data: Hex }) => Promise<bigint>
  gasPrice: () => Promise<bigint>
}

export interface SendMessageTxDeps extends MessageTxDeps {
  /** Execute + persist; resolves to the tx hash. */
  apply: (req: MessageTxRequest) => Promise<Hex>
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })

function firstParam(req: RpcRequest): Record<string, unknown> | null {
  const params = req.params
  const p = Array.isArray(params) && params.length > 0 ? params[0] : null
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
}

function quantity(o: Record<string, unknown>, key: string): Parsed<bigint | undefined> {
  const v = o[key]
  if (v === undefined || v === null) return { ok: true, value: undefined }
  if (typeof v !== 'string' || !QUANTITY_RE.test(v)) return bad(`${key} must be a 0x-hex quantity`)
  return { ok: true, value: toBigInt(v) }
}

/** Every field either method accepts; nothing is mandatory at this stage. */
export interface ParsedParams {
  from?: Hex
  /** null = contract creation */
  to: Hex | null
  value: bigint
  data: Uint8Array
  nonce?: bigint
  gasLimit?: bigint
  fee?: MessageTxFee
}

export function parseParams(req: RpcRequest): Parsed<ParsedParams> {
  const o = firstParam(req)
  if (!o) return bad('expected [{to?, value?, data?, nonce, gas?, gasPrice? | maxFeePerGas?, maxPriorityFeePerGas?, …}]')

  const to = o['to']
  const out: ParsedParams = { to: null, value: 0n, data: new Uint8Array(0) }
  if (to !== undefined && to !== null && to !== '') {
    if (typeof to !== 'string' || !ADDRESS_RE.test(to)) return bad('to must be a 20-byte 0x address, or omitted for a contract creation')
    out.to = toAddress(to)
  }

  const from = o['from']
  if (from !== undefined && from !== null) {
    if (typeof from !== 'string' || !ADDRESS_RE.test(from)) return bad('from must be a 20-byte 0x address')
    out.from = toAddress(from)
  }

  const value = quantity(o, 'value')
  if (!value.ok) return value
  if (value.value !== undefined) out.value = value.value

  const d = o['data'] ?? o['input']
  if (d !== undefined && d !== null) {
    if (typeof d !== 'string' || !HEX_BYTES_RE.test(d)) return bad('data must be 0x-prefixed even-length hex')
    out.data = hexToBytes(d)
  }

  const nonce = quantity(o, 'nonce')
  if (!nonce.ok) return nonce
  out.nonce = nonce.value
  const gas = quantity(o, 'gas')
  if (!gas.ok) return gas
  out.gasLimit = gas.value

  const gasPrice = quantity(o, 'gasPrice')
  if (!gasPrice.ok) return gasPrice
  const maxFee = quantity(o, 'maxFeePerGas')
  if (!maxFee.ok) return maxFee
  const maxPrio = quantity(o, 'maxPriorityFeePerGas')
  if (!maxPrio.ok) return maxPrio
  if (gasPrice.value !== undefined && (maxFee.value !== undefined || maxPrio.value !== undefined)) {
    return bad('pass either gasPrice (legacy) or maxFeePerGas/maxPriorityFeePerGas (EIP-1559), not both')
  }
  if (gasPrice.value !== undefined) out.fee = { gasPrice: gasPrice.value }
  else if (maxFee.value !== undefined) {
    const tip = maxPrio.value ?? 0n
    if (tip > maxFee.value) return bad('maxPriorityFeePerGas must not exceed maxFeePerGas')
    out.fee = { maxFeePerGas: maxFee.value, maxPriorityFeePerGas: tip }
  } else if (maxPrio.value !== undefined) return bad('maxPriorityFeePerGas requires maxFeePerGas')

  return { ok: true, value: out }
}

const signedFields = (p: ParsedParams, nonce: bigint): MessageTxFields => ({
  nonce,
  to: p.to,
  value: p.value,
  data: p.data,
})

export async function rpcTransactionMessage(req: RpcRequest, cfg: Config, deps: MessageTxDeps): Promise<RpcResponse> {
  const parsed = parseParams(req)
  if (!parsed.ok) return makeError(req.id, ERR_INVALID_PARAMS, parsed.error)
  const p = parsed.value
  if (p.nonce === undefined && p.from === undefined) {
    return makeError(req.id, ERR_INVALID_PARAMS, 'pass nonce, or from so it can be read from the sandbox')
  }
  try {
    const nonce = p.nonce ?? (await deps.nonce(p.from!))
    const message = transactionMessage(messageChainName(cfg), signedFields(p, nonce))
    return makeResult(req.id, { message, nonce: toQuantity(nonce) })
  } catch (e) {
    return makeError(req.id, ERR_INVALID_PARAMS, String((e as Error).message ?? e))
  }
}

export async function rpcSendMessageTx(req: RpcRequest, cfg: Config, deps: SendMessageTxDeps): Promise<RpcResponse> {
  const parsed = parseParams(req)
  if (!parsed.ok) return makeError(req.id, ERR_INVALID_PARAMS, parsed.error)
  const p = parsed.value
  if (p.nonce === undefined) return makeError(req.id, ERR_INVALID_PARAMS, 'nonce is required (it is part of the signed message)')
  const signature = firstParam(req)!['signature']
  if (typeof signature !== 'string' || !isHex(signature) || hexToBytes(signature).length !== 65) {
    return makeError(req.id, ERR_INVALID_PARAMS, 'signature must be 65 bytes of 0x-hex')
  }

  const fields = signedFields(p, p.nonce)
  let message: string
  try {
    message = transactionMessage(messageChainName(cfg), fields)
  } catch (e) {
    return makeError(req.id, ERR_INVALID_PARAMS, String((e as Error).message ?? e))
  }

  let signer: Hex
  try {
    signer = await recoverMessageSigner(message, signature)
  } catch (e) {
    return makeError(req.id, ERR_INVALID_PARAMS, `cannot recover signer: ${String((e as Error).message ?? e)}`)
  }

  try {
    // Unsigned gas terms: what a wallet would have filled in for this sender.
    const gasLimit =
      p.gasLimit ??
      (await deps.estimateGas({
        from: signer,
        ...(p.to ? { to: p.to } : {}),
        value: toQuantity(p.value),
        data: bytesToHex(p.data),
      }))
    const fee: MessageTxFee = p.fee ?? { maxFeePerGas: await deps.gasPrice(), maxPriorityFeePerGas: 0n }
    const hash = await deps.apply({ ...fields, signer, message, signature, gasLimit, fee })
    return makeResult(req.id, hash)
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}
