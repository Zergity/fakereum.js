// Offline builders for the texts a wallet signs — byte-for-byte the same as
// the sandbox reconstructs server-side (fakereum.js src/lib/eip191.ts and
// src/import_balance.ts), so a client can show the exact text before asking
// for a signature, or build it without a round trip.

import { bytesToHex, checksumAddress, hexToBytes, keccak256, toBigInt, type Hex } from './hex'

/** The signed part of a transaction. Gas terms are not signed. */
export interface SignedTxFields {
  nonce: bigint | number | string
  /** Recipient; omit / null for a contract creation (data = init code). */
  to?: Hex | string | null
  value?: bigint | number | string
  data?: Hex | string
}

export const CREATE_TO_LINE = 'CREATE'

/** Decimal in native units with up to 18 fractional digits, trailing zeros dropped. */
export function formatValue(wei: bigint): string {
  if (wei < 0n) throw new Error('value must not be negative')
  const base = 10n ** 18n
  const whole = wei / base
  const frac = wei % base
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(18, '0').replace(/0+$/, '')}`
}

/** "0x<first 4 bytes>" plus " and <n> bytes with hash 0x…" when data runs past 4 bytes. */
export function formatData(data: Uint8Array): string {
  const head = bytesToHex(data.subarray(0, 4))
  if (data.length <= 4) return head
  const tail = data.subarray(4)
  return `${head} and ${tail.length} bytes with hash ${keccak256(tail)}`
}

/**
 * The exact EIP-191 text for a sandbox transaction. `chainName` is the forked
 * chain's name — discovery's `upstreamChainName`, e.g. "Arbitrum One":
 *
 *   Fakereum Tx #<nonce> on <chainName>
 *   To: <EIP-55 address>            (or "To: CREATE")
 *   Value: <native units>           (only when value > 0)
 *   Data: <summary>                 (only when data is non-empty)
 */
export function buildTransactionMessage(chainName: string, f: SignedTxFields): string {
  const nonce = toBigInt(f.nonce)
  const value = toBigInt(f.value)
  const data = f.data ? hexToBytes(f.data) : new Uint8Array(0)
  const lines = [`Fakereum Tx #${nonce} on ${chainName}`, `To: ${f.to ? checksumAddress(f.to) : CREATE_TO_LINE}`]
  if (value > 0n) lines.push(`Value: ${formatValue(value)}`)
  if (data.length > 0) lines.push(`Data: ${formatData(data)}`)
  return lines.join('\n')
}

/**
 * The exact EIP-191 text authorizing a cross-chain balance import. `chainName`
 * is the sandbox's forked chain (discovery's `upstreamChainName`):
 *
 *   Fakereum Import to <chainName>
 *   Account: <EIP-55 address>
 *   From: <source chain name> (chain id <id>)
 */
export function buildImportMessage(
  chainName: string,
  account: string,
  source: { name: string; chainId: bigint | number | string },
): string {
  return [
    `Fakereum Import to ${chainName}`,
    `Account: ${checksumAddress(account)}`,
    `From: ${source.name} (chain id ${toBigInt(source.chainId)})`,
  ].join('\n')
}
