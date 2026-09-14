// env (wrangler vars + secrets) -> resolved Config. Replaces config.go's
// flag/.env/JSON resolution; in Workers every knob arrives as an env string.

import type { Config, Env, EthCallStorageMode, EtherscanStyle, GenesisAlloc } from './types'
import { toAddress, type Hex } from './lib/hex'
import {
  chainName,
  deriveSandboxChainID,
  upstreamNativeSymbol,
} from './lib/chains'

function splitCSV(s: string | undefined): string[] {
  if (!s) return []
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

/** Parse a decimal or 0x-hex chain id; 0n on empty. */
function parseChainID(s: string | undefined): bigint {
  if (!s || s.trim() === '') return 0n
  const t = s.trim()
  if (t.startsWith('0x') || t.startsWith('0X')) return BigInt(t)
  return BigInt(t)
}

/** ws(s):// upstreams are rewritten to http(s):// — the Worker speaks fetch(). */
function toHttpUpstream(u: string): string {
  if (u.startsWith('wss://')) return 'https://' + u.slice('wss://'.length)
  if (u.startsWith('ws://')) return 'http://' + u.slice('ws://'.length)
  return u
}

function parseRejectSigners(s: string | undefined): boolean | null {
  if (!s || s.trim() === '' || s.trim().toLowerCase() === 'auto') return null
  return s.trim().toLowerCase() === 'true'
}

function parseImpersonateSeed(s: string | undefined): Array<[Hex, Hex]> {
  // Format "B:A,B2:A2" (impersonator:impersonatee).
  const out: Array<[Hex, Hex]> = []
  for (const pair of splitCSV(s)) {
    const [b, a] = pair.split(':').map((x) => x.trim())
    if (b && a) out.push([toAddress(b), toAddress(a)])
  }
  return out
}

function parseGenesis(s: string | undefined): GenesisAlloc | null {
  if (!s || s.trim() === '') return null
  try {
    const g = JSON.parse(s) as GenesisAlloc
    if (g && typeof g === 'object' && g.alloc && typeof g.alloc === 'object') return g
  } catch {
    /* ignore malformed genesis */
  }
  return null
}

export function loadConfig(env: Env): Config {
  const mode = (env.ETH_CALL_STORAGE_MODE || 'stateOverride').trim()
  const ethCallStorageMode: EthCallStorageMode =
    mode === 'getStorageAt' ? 'getStorageAt' : 'stateOverride'

  const ttlSec = env.CACHE_TTL && env.CACHE_TTL.trim() !== '' ? Number(env.CACHE_TTL) : 12
  const rps = env.RATE_LIMIT_RPS && env.RATE_LIMIT_RPS.trim() !== '' ? Number(env.RATE_LIMIT_RPS) : 0

  const upstreamEtherscan = (env.UPSTREAM_ETHERSCAN || 'https://api.etherscan.io/v2/api').trim()
  const styleRaw = (env.UPSTREAM_ETHERSCAN_STYLE || '').trim().toLowerCase()
  const etherscanStyle: EtherscanStyle =
    styleRaw === 'blockscout' ||
    (styleRaw !== 'etherscan' && upstreamEtherscan.toLowerCase().includes('blockscout'))
      ? 'blockscout'
      : 'etherscan'

  return {
    upstreamRpcs: splitCSV(env.UPSTREAM_RPC || 'https://ethereum-rpc.publicnode.com').map(
      toHttpUpstream,
    ),
    upstreamEtherscan,
    etherscanStyle,
    etherscanKeys: splitCSV(env.ETHERSCAN_API_KEY),
    chainId: parseChainID(env.CHAIN_ID),
    upstreamChainId: 0n,
    symbol: (env.SYMBOL || '').trim(),
    networkName: (env.NETWORK_NAME || '').trim(),
    ethCallStorageMode,
    cacheTtlMs: Number.isFinite(ttlSec) ? Math.max(0, ttlSec) * 1000 : 12_000,
    rejectUpstreamSigners: parseRejectSigners(env.REJECT_UPSTREAM_SIGNERS),
    admins: splitCSV(env.ADMINS).map(toAddress),
    impersonateSeed: parseImpersonateSeed(env.IMPERSONATE),
    corsOrigins: splitCSV(env.CORS_ORIGINS),
    rateLimitRps: Number.isFinite(rps) ? rps : 0,
    rateLimitExempt: splitCSV(env.RATE_LIMIT_EXEMPT),
    genesis: parseGenesis(env.GENESIS),
    balanceMultiplier: parseBalanceMultiplier(env.BALANCE_MULTIPLIER),
    resolved: false,
  }
}

export const DEFAULT_BALANCE_MULTIPLIER = 1000n

/** Positive integer; blank/invalid → 1000. A value of 1 turns scaling off. */
export function parseBalanceMultiplier(raw: string | undefined): bigint {
  const t = (raw ?? '').trim()
  if (t === '') return DEFAULT_BALANCE_MULTIPLIER
  if (!/^[0-9]+$/.test(t)) return DEFAULT_BALANCE_MULTIPLIER
  const n = BigInt(t)
  return n >= 1n ? n : DEFAULT_BALANCE_MULTIPLIER
}

/**
 * Fill chainId / symbol / networkName once the upstream chain id is known.
 * Mirrors main.go's post-discovery derivation. Idempotent.
 */
export function resolveConfig(cfg: Config, upstreamChainId: bigint): void {
  cfg.upstreamChainId = upstreamChainId
  if (cfg.chainId === 0n) cfg.chainId = deriveSandboxChainID(upstreamChainId)
  if (cfg.symbol === '') cfg.symbol = 'F' + upstreamNativeSymbol(upstreamChainId)
  if (cfg.networkName === '') cfg.networkName = 'Fake ' + chainName(upstreamChainId)
  cfg.resolved = true
}

/** Effective replay-guard verdict (auto = on iff sandbox id == upstream id). */
export function rejectUpstreamSignersEnabled(cfg: Config): boolean {
  if (cfg.rejectUpstreamSigners !== null) return cfg.rejectUpstreamSigners
  return cfg.chainId === cfg.upstreamChainId
}
