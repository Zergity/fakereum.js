// Chain metadata: human-readable names, native symbols, and public explorers
// for well-known upstream chain ids. Mirrors landing.go (knownChains),
// main.go (upstreamNativeSymbol), and tx_explorer.go (upstreamExplorers).

export interface UpstreamExplorer {
  name: string
  /** Host root, no trailing slash, e.g. "https://arbiscan.io". */
  base: string
}

const knownChains: Record<string, string> = {
  '1': 'Ethereum Mainnet',
  '10': 'Optimism',
  '56': 'BNB Smart Chain',
  '100': 'Gnosis',
  '137': 'Polygon',
  '250': 'Fantom',
  '8453': 'Base',
  '42161': 'Arbitrum One',
  '4663': 'Robinhood Chain',
  '43111': 'Hemi',
  '43114': 'Avalanche',
  '59144': 'Linea',
  '534352': 'Scroll',
  '11155111': 'Sepolia',
  '17000': 'Holesky',
}

const upstreamExplorers: Record<string, UpstreamExplorer> = {
  '1': { name: 'Etherscan', base: 'https://etherscan.io' },
  '10': { name: 'Optimistic Etherscan', base: 'https://optimistic.etherscan.io' },
  '56': { name: 'BscScan', base: 'https://bscscan.com' },
  '100': { name: 'GnosisScan', base: 'https://gnosisscan.io' },
  '137': { name: 'Polygonscan', base: 'https://polygonscan.com' },
  '250': { name: 'FtmScan', base: 'https://ftmscan.com' },
  '8453': { name: 'BaseScan', base: 'https://basescan.org' },
  '42161': { name: 'Arbiscan', base: 'https://arbiscan.io' },
  '43111': { name: 'Hemi Explorer', base: 'https://explorer.hemi.xyz' },
  '43114': { name: 'SnowTrace', base: 'https://snowtrace.io' },
  '59144': { name: 'LineaScan', base: 'https://lineascan.build' },
  '534352': { name: 'ScrollScan', base: 'https://scrollscan.com' },
  '11155111': { name: 'Sepolia Etherscan', base: 'https://sepolia.etherscan.io' },
  '17000': { name: 'Holesky Etherscan', base: 'https://holesky.etherscan.io' },
}

export function chainName(id: bigint): string {
  return knownChains[id.toString()] ?? `chain ${id.toString()}`
}

export function upstreamExplorerForChain(id: bigint): UpstreamExplorer {
  return upstreamExplorers[id.toString()] ?? { name: 'blockscan.com', base: 'https://blockscan.com' }
}

/** Native currency symbol for a chain id, default "ETH" (so unknown -> "FETH"). */
export function upstreamNativeSymbol(id: bigint): string {
  switch (id) {
    case 56n:
    case 97n:
      return 'BNB'
    case 100n:
      return 'XDAI'
    case 137n:
    case 80002n:
      return 'POL'
    case 250n:
    case 4002n:
      return 'FTM'
    case 25n:
      return 'CRO'
    case 43114n:
    case 43113n:
      return 'AVAX'
    case 42220n:
      return 'CELO'
    case 1284n:
      return 'GLMR'
    case 1285n:
      return 'MOVR'
    case 30n:
      return 'RBTC'
    case 369n:
      return 'PLS'
    default:
      return 'ETH'
  }
}

/**
 * Sandbox chain id derived by prefixing the upstream id with "420" in decimal
 * (upstream 1 -> 4201, upstream 42161 -> 42042161). Mirrors deriveSandboxChainID.
 */
export function deriveSandboxChainID(upstream: bigint): bigint {
  let mul = 1n
  for (let n = upstream; n > 0n; n /= 10n) mul *= 10n
  if (mul === 1n) mul = 10n
  return 420n * mul + upstream
}
