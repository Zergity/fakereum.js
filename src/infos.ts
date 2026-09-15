// Sandbox-discovery sentinel. A dapp eth_calls 0x..fa4e and gets the sandbox
// info ABI-encoded as a single `string` (JSON). Wallets won't forward custom
// fakereum_* methods but always forward eth_call, so this is the wallet-safe
// discovery path. No real chain has code at this address. Ports infos.go.

import type { Config, Infos } from './types'
import { makeResult, type RpcRequest, type RpcResponse } from './rpc'
import { addrEq, bytesToHex, concatBytes, type Hex } from './lib/hex'
import { chainName, upstreamExplorerForChain } from './lib/chains'

export const INFOS_SENTINEL = '0x000000000000000000000000000000000000fa4e' as Hex

export function buildInfos(cfg: Config, baseURL: string): Infos {
  const res: Infos = {
    chainId: ('0x' + cfg.chainId.toString(16)) as Hex,
    upstreamChainId: ('0x' + cfg.upstreamChainId.toString(16)) as Hex,
    networkName: cfg.networkName,
    symbol: cfg.symbol,
    upstreamChainName: chainName(cfg.upstreamChainId),
  }
  if (baseURL) {
    res.rpc = baseURL + '/rpc'
    res.etherscanApi = baseURL + '/api'
    res.etherscanApiV2 = baseURL + '/v2/api'
    res.explorer = baseURL
  }
  if (cfg.upstreamRpcs[0]) res.upstreamRpc = cfg.upstreamRpcs[0]
  const ex = upstreamExplorerForChain(cfg.upstreamChainId)
  if (ex.base) res.upstreamExplorer = { name: ex.name, url: ex.base }
  return res
}

/** ABI-encode bytes as a single dynamic `string` return value. */
export function abiEncodeString(bytes: Uint8Array): Hex {
  const head = new Uint8Array(64)
  head[31] = 0x20 // offset to the string data
  // length in the low 8 bytes of word 2. Use division, not `>>>` (which is
  // 32-bit and would wrap + double-write for byte indices >= 4).
  let len = bytes.length
  for (let i = 0; i < 8; i++) {
    head[63 - i] = len & 0xff
    len = Math.floor(len / 256)
  }
  const body = new Uint8Array((bytes.length + 31) & ~31)
  body.set(bytes)
  return bytesToHex(concatBytes(head, body))
}

/**
 * Handle eth_call to the infos sentinel. Returns the ABI-encoded info response,
 * or null for any other target (so the caller falls through to the normal
 * eth_call path). Calldata is ignored — any call to the sentinel answers.
 */
export function rpcInfosCall(req: RpcRequest, cfg: Config, baseURL: string): RpcResponse | null {
  const params = req.params
  if (!Array.isArray(params) || params.length === 0) return null
  const call = params[0]
  if (!call || typeof call !== 'object') return null
  const to = (call as Record<string, unknown>)['to']
  if (typeof to !== 'string' || !addrEq(to, INFOS_SENTINEL)) return null
  const json = JSON.stringify(buildInfos(cfg, baseURL))
  return makeResult(req.id, abiEncodeString(new TextEncoder().encode(json)))
}
