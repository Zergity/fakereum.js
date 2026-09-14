// Source chains a user may import a native balance from (see
// import_balance.ts). Public, keyless RPCs with failover; the read is a single
// eth_getBalance at `latest`. The sandbox's own upstream chain is never a
// source here — that import is automatic (upstream × multiplier).

import { toBigInt, type Hex } from './hex'

export interface ImportChain {
  chainId: bigint
  name: string
  symbol: string
  rpcs: string[]
}

export const IMPORT_CHAINS: readonly ImportChain[] = [
  {
    chainId: 1n,
    name: 'Ethereum Mainnet',
    symbol: 'ETH',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'],
  },
  {
    chainId: 42161n,
    name: 'Arbitrum One',
    symbol: 'ETH',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  },
  {
    chainId: 8453n,
    name: 'Base',
    symbol: 'ETH',
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  },
  {
    chainId: 4663n,
    name: 'Robinhood Chain',
    symbol: 'ETH',
    rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
  },
]

export function importChain(chainId: bigint): ImportChain | undefined {
  return IMPORT_CHAINS.find((c) => c.chainId === chainId)
}

const READ_TIMEOUT_MS = 10_000

/** Native balance of `addr` on a source chain, trying each RPC in turn. */
export async function readNativeBalance(
  chain: ImportChain,
  addr: Hex,
  fetchFn: typeof fetch = fetch,
): Promise<bigint> {
  let lastErr: unknown = null
  for (const url of chain.rpcs) {
    try {
      const r = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
      if (j.error) throw new Error(j.error.message ?? 'rpc error')
      if (typeof j.result !== 'string') throw new Error('malformed balance')
      return toBigInt(j.result)
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`${chain.name}: every RPC failed (${String((lastErr as Error)?.message ?? lastErr)})`)
}
