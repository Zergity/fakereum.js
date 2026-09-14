// Thin typed helpers over the sandbox's fakereum_* JSON-RPC methods. Wallets
// never relay these, so they always go straight to the sandbox RPC URL.

import { rpc } from './rpc'
import { toQuantity, type Hex } from './hex'

export type AccountKind = 'sandbox' | 'upstream'

export interface AccountKindInfo {
  address: Hex
  /** 'upstream' = funded on the real chain: signed-message txs only, never EIP-712. */
  kind: AccountKind
  /** True once the account's first sandbox tx (or import) landed; the kind never changes after. */
  pinned: boolean
  /** False on a sandbox with its own chain id: nothing can replay, every account is 'sandbox'. */
  replayGuard: boolean
}

/** eth_sendTransaction-shaped request. Numbers may be bigint, number, hex or decimal strings. */
export interface TxRequest {
  from?: string
  to?: string | null
  value?: bigint | number | string
  data?: string
  input?: string
  nonce?: bigint | number | string
  gas?: bigint | number | string
  gasPrice?: bigint | number | string
  maxFeePerGas?: bigint | number | string
  maxPriorityFeePerGas?: bigint | number | string
}

const QUANTITY_KEYS = ['value', 'nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const

/** Normalize a TxRequest into the 0x-hex shape the sandbox expects. */
export function toRpcTx(tx: TxRequest): Record<string, string> {
  const out: Record<string, string> = {}
  if (tx.from) out['from'] = tx.from
  if (tx.to) out['to'] = tx.to
  const data = tx.data ?? tx.input
  if (data && data !== '0x') out['data'] = data
  for (const k of QUANTITY_KEYS) {
    const v = tx[k]
    if (v === undefined || v === null || v === '') continue
    out[k] = typeof v === 'string' && v.startsWith('0x') ? v : toQuantity(BigInt(v))
  }
  return out
}

export function accountKind(rpcUrl: string, address: string): Promise<AccountKindInfo> {
  return rpc<AccountKindInfo>(rpcUrl, 'fakereum_accountKind', [address])
}

/** The text to sign (and the nonce it carries) for `tx`; pass `from` to have the nonce read. */
export function transactionMessage(rpcUrl: string, tx: TxRequest): Promise<{ message: string; nonce: Hex }> {
  return rpc(rpcUrl, 'fakereum_transactionMessage', [toRpcTx(tx)])
}

/** Submit signed fields + the personal_sign signature; resolves to the tx hash. */
export function sendTransaction(rpcUrl: string, tx: TxRequest & { signature: string }): Promise<Hex> {
  const { signature, ...rest } = tx
  const { from: _from, ...fields } = toRpcTx(rest) // `from` is recovered from the signature
  return rpc<Hex>(rpcUrl, 'fakereum_sendTransaction', [{ ...fields, signature }])
}

export interface ImportSource {
  chainId: Hex
  name: string
  symbol: string
  balance?: Hex
  credit?: Hex
  error?: string
}
export interface ImportRecord {
  chainId: Hex
  balance: Hex
  credit: Hex
  signature: Hex
  at: number
}
export interface ImportSources {
  account: Hex
  multiplier: string
  imported: ImportRecord | null
  sources: ImportSource[]
}

export function importSources(rpcUrl: string, address: string): Promise<ImportSources> {
  return rpc(rpcUrl, 'fakereum_importSources', [address])
}
export function importMessage(rpcUrl: string, account: string, chainId: bigint | number | string): Promise<{ message: string }> {
  return rpc(rpcUrl, 'fakereum_importMessage', [{ account, chainId: toQuantity(BigInt(chainId)) }])
}
export function importBalance(
  rpcUrl: string,
  account: string,
  chainId: bigint | number | string,
  signature: string,
): Promise<{ account: Hex; chainId: Hex; chain: string; balance: Hex; credit: Hex; newBalance: Hex }> {
  return rpc(rpcUrl, 'fakereum_importBalance', [{ account, chainId: toQuantity(BigInt(chainId)), signature }])
}
