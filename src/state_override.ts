// Parse the geth-style eth_call/eth_estimateGas stateOverrides (params[2]) into
// the shape ForkingStateManager.applyOverride consumes. Ports state_override.go.
//   balance/nonce/code -> replace; state -> full replace (unlisted slots read 0);
//   stateDiff -> patch.

import type { AccountOverride } from './executor'
import { addrKey, hexToBytes, toBigInt, toHash32Hex } from './lib/hex'

export function parseStateOverrides(raw: unknown): Map<string, AccountOverride> | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const out = new Map<string, AccountOverride>()
  for (const [addr, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const ov: AccountOverride = {}
    if (typeof o['balance'] === 'string') ov.balance = toBigInt(o['balance'])
    if (typeof o['nonce'] === 'string') ov.nonce = toBigInt(o['nonce'])
    if (typeof o['code'] === 'string') ov.code = hexToBytes(o['code'])
    const state = o['state']
    if (state && typeof state === 'object') {
      ov.state = new Map()
      for (const [slot, val] of Object.entries(state as Record<string, unknown>)) {
        if (typeof val === 'string') ov.state.set(toHash32Hex(slot), hexToBytes(toHash32Hex(val)))
      }
    }
    const stateDiff = o['stateDiff']
    if (stateDiff && typeof stateDiff === 'object') {
      ov.stateDiff = new Map()
      for (const [slot, val] of Object.entries(stateDiff as Record<string, unknown>)) {
        if (typeof val === 'string') ov.stateDiff.set(toHash32Hex(slot), hexToBytes(toHash32Hex(val)))
      }
    }
    out.set(addrKey(addr), ov)
  }
  return out.size > 0 ? out : null
}
