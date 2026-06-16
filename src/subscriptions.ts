// WebSocket eth_subscribe helpers (sandbox-driven only — no upstream WS bridge,
// matching the Go behavior when the upstream is HTTP). The Durable Object owns
// the actual hibernatable WebSockets + per-socket sub registry; these are the
// pure render/format helpers. Ports ws_server.go (renderHead /
// buildSubscriptionMessage / newSubID).

import type { StoredTx } from './types'
import { toQuantity, type Hex } from './lib/hex'

export interface WsSub {
  id: string
  kind: 'newHeads' | 'logs'
  /** Raw eth_subscribe logs-filter object (parsed to a LogFilter at notify time). */
  filter: Record<string, unknown> | null
}

const ZERO_HASH = ('0x' + '00'.repeat(32)) as Hex
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const EMPTY_BLOOM = ('0x' + '00'.repeat(256)) as Hex
const EMPTY_UNCLES = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347'
const EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'

/** A synthetic block header for a sandbox-applied tx (ws_server.go renderHead). */
export function renderHead(tx: StoredTx): Record<string, unknown> {
  return {
    number: tx.blockNumber,
    hash: tx.blockHash,
    parentHash: ZERO_HASH,
    nonce: '0x0000000000000000',
    mixHash: ZERO_HASH,
    sha3Uncles: EMPTY_UNCLES,
    logsBloom: EMPTY_BLOOM,
    transactionsRoot: EMPTY_ROOT,
    stateRoot: ZERO_HASH,
    receiptsRoot: EMPTY_ROOT,
    miner: ZERO_ADDR,
    difficulty: '0x0',
    extraData: '0x',
    gasLimit: '0x0',
    gasUsed: tx.gasUsed,
    timestamp: tx.blockTime,
    baseFeePerGas: '0x0',
  }
}

/** The eth_subscription notification frame dapps listen for. */
export function subscriptionFrame(subId: string, result: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_subscription',
    params: { subscription: subId, result },
  })
}

/** A random 16-byte subscription id (0x-hex). */
export function newSubId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = '0x'
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export { toQuantity }
