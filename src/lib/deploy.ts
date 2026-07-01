// Deploy-method resolution for the explorer.
//
// New txs carry the mechanism captured live from the EVM (StoredTx.createdVia).
// Txs stored before that capture existed have no createdVia, so we reconstruct
// the mechanism deterministically from the persisted state diff:
//   - the top-level (zero-`to` tx) deploy is always a plain CREATE;
//   - an internal deploy is a CREATE iff its address equals a nonce-based
//     derivation keccak(rlp([deployer, nonce]))[12:] for some deployer/nonce in
//     the diff (every CREATE/CREATE2 bumps the deployer's nonce, so all deployers
//     appear in the diff). No match => it must be CREATE2 (salt-based).

import { bigIntToBytes, generateAddress } from '@ethereumjs/util'
import type { DeployMethod, StoredTx } from '../types'
import { addrKey, equalBytes, hexToBytes, toBigInt } from './hex'

// Safety bound on total nonce derivations per reconstruction, so a factory with
// a huge nonce span can't blow up a render. Beyond it we fall back to 'create2'.
const MAX_DERIVATIONS = 4096

/**
 * The deploy method for a contract created at `key` (a lowercased 0x address, as
 * produced by addrKey / the diff keys) within `tx`. Prefers the captured method;
 * falls back to reconstruction for older txs. Only call for addresses that were
 * actually deployed (in tx.createdContracts / a code diff).
 */
export function resolveDeployMethod(tx: StoredTx, key: string): DeployMethod {
  const captured = tx.createdVia?.[key]
  if (captured) return captured
  // Top-level (zero-`to` tx) deploy is always a plain CREATE.
  if (tx.contractAddress && addrKey(tx.contractAddress) === key) return 'tx'
  return reconstructInternal(tx, key)
}

function reconstructInternal(tx: StoredTx, key: string): DeployMethod {
  const accounts = tx.diff?.accounts
  if (!accounts) return 'create2'
  const target = hexToBytes(key)
  if (target.length !== 20) return 'create2'

  let derivations = 0
  for (const [addr, ad] of Object.entries(accounts)) {
    if (!ad.nonceChanged) continue
    const from = hexToBytes(addr)
    if (from.length !== 20) continue
    const pre = toBigInt(ad.preNonce ?? '0x0')
    const post = toBigInt(ad.postNonce ?? '0x0')
    for (let n = pre; n < post; n++) {
      if (++derivations > MAX_DERIVATIONS) return 'create2'
      if (equalBytes(generateAddress(from, bigIntToBytes(n)), target)) return 'create'
    }
  }
  return 'create2'
}
