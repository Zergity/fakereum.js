// Classify a JSON-RPC "block tag" — the block parameter of eth_call /
// eth_estimateGas / eth_getBalance / eth_getTransactionCount / eth_getCode /
// eth_getStorageAt — for the forked-EVM sandbox.
//
// The sandbox keeps one sticky overlay layered on upstream@latest: the "sandbox
// tip". A state read either reflects that tip (overlay on) or a concrete
// historical block on the real chain (overlay off, forwarded upstream verbatim).
// Named tags decide this on their own; a numeric block needs the current tip —
// it is historical only when strictly below it, so the overlay still answers a
// read pinned to the block a just-sent sandbox tx landed in.

import { toBigInt } from './hex'

export type BlockTagClass =
  | { kind: 'overlay' } // sandbox tip: latest/pending/safe/finalized/omitted
  | { kind: 'historical' } // real chain @ a fixed past block: hash / earliest
  | { kind: 'number'; number: bigint } // numeric block — compare against the tip

/**
 * First-pass classification that needs no upstream call. A `number` result must
 * still be compared against the current tip (numeric < tip ⇒ historical).
 *
 * Accepts the plain string form and the EIP-1898 object form
 * ({ blockNumber } / { blockHash }).
 */
export function classifyBlockTag(tag: unknown): BlockTagClass {
  if (tag == null) return { kind: 'overlay' }
  if (typeof tag === 'object') {
    const o = tag as Record<string, unknown>
    if (typeof o['blockHash'] === 'string') return { kind: 'historical' }
    if (typeof o['blockNumber'] === 'string') return numeric(o['blockNumber'])
    return { kind: 'overlay' }
  }
  if (typeof tag !== 'string') return { kind: 'overlay' }
  switch (tag.toLowerCase()) {
    case '':
    case 'latest':
    case 'pending':
    case 'safe':
    case 'finalized':
      return { kind: 'overlay' }
    case 'earliest':
      return { kind: 'historical' }
  }
  if (/^0x[0-9a-f]{64}$/i.test(tag)) return { kind: 'historical' } // 32-byte block hash
  return numeric(tag)
}

function numeric(v: string): BlockTagClass {
  try {
    return { kind: 'number', number: toBigInt(v) }
  } catch {
    // Unparseable → fall back to the sandbox tip rather than a wrong historical
    // passthrough. A malformed tag is better answered with current state.
    return { kind: 'overlay' }
  }
}
