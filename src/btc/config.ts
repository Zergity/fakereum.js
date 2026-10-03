// env (wrangler vars + secrets) -> resolved BTC sandbox config.

import type { Env } from '../types'
import { NETWORKS, type Network } from './address'

export interface BtcConfig {
  network: Network
  /** Esplora base URLs (each ending in /api), tried in order. Empty = standalone chain. */
  upstreamEsplora: string[]
  upstreamTimeoutMs: number
  /** Largest single faucet mint, in satoshis. */
  faucetMaxSats: bigint
  /** Minimum relay feerate, satoshis per 1000 vbytes. */
  minRelayFeePerKvB: number
  /** Feerate (sat/vB) reported by the fee estimators. */
  feeRate: number
  corsOrigins: string[]
  rateLimitRps: number
  rateLimitExempt: string[]
  /** Addresses (P2WPKH / P2SH-P2WPKH / P2TR) allowed to sign admin actions. Empty = admin tools disabled. */
  admins: string[]
  /** Initial impersonation pairs: [impersonator, impersonatee] addresses. */
  impersonateSeed: Array<[string, string]>
  /** Addresses funded at the start of the sandbox timeline (and again after a clear). */
  genesis: Array<{ address: string; sats: bigint }>
  /** Real outputs count for this many times their value inside the sandbox (default 1 = off). */
  balanceMultiplier: bigint
  /** Explorer pages show the upstream chain's identity and drop sandbox wording and controls. */
  uiUpstream: boolean
}

export const DEFAULT_FAUCET_MAX_SATS = 100n * 100_000_000n
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000

function splitCSV(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

function posInt(raw: string | undefined, dflt: number): number {
  const t = (raw ?? '').trim()
  if (!/^[0-9]+$/.test(t)) return dflt
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : dflt
}

/** "B:A,B2:A2" (impersonator:impersonatee), the same form the EVM sandbox takes. */
function parsePairs(s: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const pair of splitCSV(s)) {
    const [b, a] = pair.split(':').map((x) => x.trim())
    if (b && a) out.push([b, a])
  }
  return out
}

/** `{"alloc":{"<address>":{"balance":"<satoshis>"}}}`, the EVM GENESIS shape with balances in satoshis. */
function parseGenesis(s: string | undefined): Array<{ address: string; sats: bigint }> {
  if (!s || s.trim() === '') return []
  try {
    const g = JSON.parse(s) as { alloc?: Record<string, { balance?: string | number }> }
    return Object.entries(g.alloc ?? {})
      .filter(([, v]) => /^[0-9]+$/.test(String(v?.balance ?? '')) && BigInt(String(v.balance)) > 0n)
      .map(([address, v]) => ({ address, sats: BigInt(String(v.balance)) }))
  } catch {
    return []
  }
}

export function loadBtcConfig(env: Env): BtcConfig {
  const name = (env.BTC_NETWORK ?? '').trim().toLowerCase()
  const network = NETWORKS[name as keyof typeof NETWORKS] ?? NETWORKS.mainnet
  const faucet = (env.FAUCET_MAX_SATS ?? '').trim()
  const rps = Number((env.RATE_LIMIT_RPS ?? '').trim())
  return {
    network,
    upstreamEsplora: splitCSV(env.UPSTREAM_ESPLORA).map((u) => u.replace(/\/+$/, '')),
    upstreamTimeoutMs: Math.max(1000, posInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS)),
    faucetMaxSats: /^[0-9]+$/.test(faucet) && BigInt(faucet) > 0n ? BigInt(faucet) : DEFAULT_FAUCET_MAX_SATS,
    minRelayFeePerKvB: posInt(env.MIN_RELAY_FEE_SAT_KVB, 1000),
    feeRate: Math.max(1, posInt(env.FEE_RATE_SAT_VB, 2)),
    corsOrigins: splitCSV(env.CORS_ORIGINS),
    rateLimitRps: Number.isFinite(rps) ? rps : 0,
    rateLimitExempt: splitCSV(env.RATE_LIMIT_EXEMPT),
    admins: splitCSV(env.ADMINS),
    impersonateSeed: parsePairs(env.IMPERSONATE),
    genesis: parseGenesis(env.GENESIS),
    balanceMultiplier: /^[0-9]+$/.test((env.BALANCE_MULTIPLIER ?? '').trim()) && BigInt(env.BALANCE_MULTIPLIER!.trim()) >= 1n
      ? BigInt(env.BALANCE_MULTIPLIER!.trim())
      : 1n,
    uiUpstream: (env.UI_MODE ?? '').trim().toLowerCase() === 'upstream',
  }
}
