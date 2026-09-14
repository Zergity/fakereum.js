// EIP-191 "signed message" transactions. A wallet's personal_sign is
// chain-agnostic and never produces anything a node would accept as a
// transaction, so a user can drive the sandbox from a wallet that is on any
// chain (or has no sandbox network added at all) by signing a short, readable
// message naming the nonce, the destination, the value and the calldata. The
// server rebuilds that text from the submitted fields, recovers the signer,
// and executes a normal transaction from that address. Gas limit and fee terms
// ride along unsigned in the RPC params (defaulted when omitted): this is a
// test sandbox, and nothing harmful can be done with them without the binding
// signature over what matters.
//
// The message text is the contract between client and server. Byte for byte:
//
//   Fakereum Tx #<nonce> on <networkName>
//   To: <EIP-55 checksummed address>
//   Value: <decimal, whole native units, up to 10 fractional digits>   (only when value > 0)
//   Data: 0x<first 4 bytes> and <n> bytes with hash 0x<keccak256(data[4:])>  (only when data is non-empty;
//                                                                            the " and … hash …" tail only
//                                                                            when data is longer than 4 bytes)
//
// Lines are joined with "\n" and there is no trailing newline. The header
// carries the sandbox's network name (what discovery and the wallet show), so
// a client can build the text offline from the discovery payload alone.

import { hashMessage, recoverMessageAddress } from 'viem'
import { bytesToHex, checksumAddress, hexToBytes, keccak256Hex, toAddress, type Hex } from './hex'

/** Fractional digits shown for the value line. */
export const VALUE_DECIMALS = 10
const WEI_PER_UNIT = 10n ** 18n
/** Smallest wei amount the value line can express: 1e-10 native units. */
export const VALUE_GRANULARITY_WEI = 10n ** BigInt(18 - VALUE_DECIMALS)
/** Everything the signed message covers. */
export interface MessageTxFields {
  nonce: bigint
  to: Hex
  value: bigint
  data: Uint8Array
}

/** Decimal with `decimals` fractional digits, trailing zeros (and a bare ".") dropped. */
function formatUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const frac = amount % base
  if (frac === 0n) return whole.toString()
  const digits = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${digits}`
}

/**
 * Render a wei amount as the value line's decimal: whole native units, then a
 * "." and the fraction with trailing zeros dropped (never more than 10 digits).
 * Throws when the amount is not a whole multiple of 1e8 wei, because the text
 * could not round-trip and the signature would then cover a different amount
 * than the one executed.
 */
export function formatMessageValue(wei: bigint): string {
  if (wei < 0n) throw new Error('value must not be negative')
  if (wei % VALUE_GRANULARITY_WEI !== 0n) {
    throw new Error(
      `value ${wei} wei is not representable with ${VALUE_DECIMALS} decimals; it must be a multiple of ${VALUE_GRANULARITY_WEI} wei`,
    )
  }
  return formatUnits(wei, 18)
}

/** The Data line for a non-empty calldata. */
export function formatMessageData(data: Uint8Array): string {
  const head = bytesToHex(data.subarray(0, 4))
  if (data.length <= 4) return head
  const tail = data.subarray(4)
  return `${head} and ${tail.length} bytes with hash ${keccak256Hex(tail)}`
}

/** The exact text a wallet must sign (personal_sign / EIP-191) for these fields. */
export function transactionMessage(networkName: string, f: MessageTxFields): string {
  const lines = [`Fakereum Tx #${f.nonce} on ${networkName}`, `To: ${checksumAddress(f.to)}`]
  if (f.value > 0n) lines.push(`Value: ${formatMessageValue(f.value)}`)
  if (f.data.length > 0) lines.push(`Data: ${formatMessageData(f.data)}`)
  return lines.join('\n')
}

/** EIP-191 digest of the message: keccak256("\x19Ethereum Signed Message:\n" + len + message). */
export function messageDigest(message: string): Hex {
  return hashMessage(message)
}

/**
 * Recover the signer of an EIP-191 signature over `message`. Accepts the 65-byte
 * r||s||v form with v in {0,1,27,28}. Returns the lowercase address; throws on a
 * malformed signature.
 */
export async function recoverMessageSigner(message: string, signature: Hex): Promise<Hex> {
  const sig = hexToBytes(signature)
  if (sig.length !== 65) throw new Error(`expected 65-byte signature, got ${sig.length}`)
  const addr = await recoverMessageAddress({ message, signature })
  return toAddress(addr)
}
