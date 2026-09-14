// Sandbox discovery: an eth_call to the sentinel address answers the sandbox's
// endpoints, ABI-encoded as a single `string` of JSON. No real chain has code
// there, so an empty or reverted answer means "not a Fakereum sandbox".

import { requester, type EIP1193Provider } from './rpc'
import type { Hex } from './hex'

export const SENTINEL = '0x000000000000000000000000000000000000fa4e' as Hex

export interface Infos {
  chainId: Hex
  upstreamChainId: Hex
  networkName: string
  symbol: string
  rpc?: string
  etherscanApi?: string
  etherscanApiV2?: string
  explorer?: string
  upstreamRpc?: string
  upstreamExplorer?: { name: string; url: string }
}

/** Decode a single ABI-encoded dynamic `string` return value to text. */
export function decodeAbiString(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length < 128) throw new Error('too short for an ABI string')
  const offset = parseInt(h.slice(0, 64), 16) * 2
  const len = parseInt(h.slice(offset, offset + 64), 16) * 2
  const data = h.slice(offset + 64, offset + 64 + len)
  const bytes = new Uint8Array(len / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes)
}

/**
 * Probe `target` — a JSON-RPC URL or an EIP-1193 provider (a wallet) — for a
 * Fakereum sandbox. Returns its infos, or null when the target is a real chain
 * (no code at the sentinel: empty result or revert).
 */
export async function discover(target: string | EIP1193Provider): Promise<Infos | null> {
  const request = requester(target)
  try {
    const data = await request('eth_call', [{ to: SENTINEL }, 'latest'])
    if (typeof data !== 'string' || data === '0x' || data.length < 130) return null
    const infos = JSON.parse(decodeAbiString(data)) as Infos
    return infos && typeof infos.chainId === 'string' ? infos : null
  } catch {
    return null
  }
}
