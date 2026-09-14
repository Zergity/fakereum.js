// Render sandbox txs/receipts/logs into JSON-RPC response shapes. Ports the
// renderTx / renderReceipt / renderLog helpers in proxy_sandbox.go. Tx-intrinsic
// fields (nonce/v/r/s/type/chainId) are re-derived from the signed raw bytes so
// a caller recomputing the hash sees matching values; block/from/signedBy come
// from the stored result.

import { parseTransaction } from 'viem'
import type { StoredLog, StoredTx } from './types'
import { checksumAddress, toQuantity, type Hex } from './lib/hex'

const LOGS_BLOOM = ('0x' + '00'.repeat(256)) as Hex
const TX_INDEX = '0x0'

const TYPE_NUM: Record<string, number> = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  eip4844: 3,
  eip7702: 4,
}

export function renderTx(tx: StoredTx): Record<string, unknown> {
  const out: Record<string, unknown> = {
    hash: tx.hash,
    from: checksumAddress(tx.from),
    // nonce from the signed bytes (tx.nonce), not the execution nonce — under
    // impersonation the latter is A's chain-state nonce and would diverge.
    nonce: tx.nonce,
    blockNumber: tx.blockNumber,
    blockHash: tx.blockHash,
    transactionIndex: TX_INDEX,
    value: tx.value,
    gas: tx.gasLimit,
    input: tx.input,
    type: toQuantity(tx.type),
    to: tx.to ? checksumAddress(tx.to) : null,
  }

  // Pull signature + fee fields from the raw signed tx.
  try {
    const p = parseTransaction(tx.raw) as Record<string, unknown>
    if (p['chainId'] !== undefined) out['chainId'] = toQuantity(p['chainId'] as bigint)
    const r = p['r'] as Hex | undefined
    const s = p['s'] as Hex | undefined
    if (r !== undefined) out['r'] = r
    if (s !== undefined) out['s'] = s
    const v = p['v'] as bigint | undefined
    const yParity = p['yParity'] as number | undefined
    if (v !== undefined) out['v'] = toQuantity(v)
    else if (yParity !== undefined) out['v'] = toQuantity(BigInt(yParity))
    if (tx.type === 2 || tx.type === 3 || tx.type === 4) {
      out['maxFeePerGas'] = p['maxFeePerGas'] !== undefined ? toQuantity(p['maxFeePerGas'] as bigint) : '0x0'
      out['maxPriorityFeePerGas'] =
        p['maxPriorityFeePerGas'] !== undefined ? toQuantity(p['maxPriorityFeePerGas'] as bigint) : '0x0'
    } else {
      out['gasPrice'] = p['gasPrice'] !== undefined ? toQuantity(p['gasPrice'] as bigint) : tx.gasPrice
    }
  } catch {
    // Malformed raw bytes shouldn't happen (we executed it), but degrade gracefully.
    out['gasPrice'] = tx.gasPrice
  }

  if (tx.signedBy && tx.signedBy.toLowerCase() !== tx.from.toLowerCase()) {
    out['signedBy'] = checksumAddress(tx.signedBy)
  }
  // A message tx's v/r/s above are the EIP-191 signature over this text, not
  // over the tx; carry the text so a client can re-verify the sender.
  if (tx.signedMessage) out['signedMessage'] = tx.signedMessage
  return out
}

export function renderReceipt(tx: StoredTx): Record<string, unknown> {
  const out: Record<string, unknown> = {
    transactionHash: tx.hash,
    transactionIndex: TX_INDEX,
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    from: checksumAddress(tx.from),
    to: tx.to ? checksumAddress(tx.to) : null,
    gasUsed: tx.gasUsed,
    cumulativeGasUsed: tx.gasUsed,
    effectiveGasPrice: tx.gasPrice && tx.gasPrice !== '0x' ? tx.gasPrice : '0x0',
    status: toQuantity(tx.status),
    logs: tx.logs.map(renderLog),
    logsBloom: LOGS_BLOOM,
    contractAddress: tx.contractAddress ? checksumAddress(tx.contractAddress) : null,
    type: '0x2',
  }
  if (tx.signedMessage) out['signedMessage'] = tx.signedMessage
  if (tx.signedBy && tx.signedBy.toLowerCase() !== tx.from.toLowerCase()) {
    out['signedBy'] = checksumAddress(tx.signedBy)
  }
  return out
}

export function renderLog(l: StoredLog): Record<string, unknown> {
  return {
    address: checksumAddress(l.address),
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    transactionIndex: l.transactionIndex,
    logIndex: l.logIndex,
    removed: l.removed,
  }
}
