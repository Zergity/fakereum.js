// Cross-chain balance import: credit an account's sandbox balance with
// (native balance on another EVM chain) × the balance multiplier, once per
// account, on the strength of an EIP-191 message the account signs. The
// wallet may be on any chain — personal_sign is chain-agnostic.
//
// The sandbox's own upstream chain is not importable here: every account
// already shows upstream × multiplier until its own sandbox state takes over.
//
//   fakereum_importSources [address]
//     -> { account, multiplier, imported, sources: [{chainId, name, symbol, balance?, credit?, error?}] }
//   fakereum_importMessage [{account, chainId}]     -> { message }
//   fakereum_importBalance [{account, chainId, signature}]
//     -> { account, chainId, balance, credit, newBalance }
//
// Message text, byte for byte ("\n"-joined, no trailing newline):
//
//   Fakereum Import to <upstream chain name>     e.g. "to Arbitrum One" (never "Fake …")
//   Account: <EIP-55 address>
//   From: <chain name> (chain id <id>)

import type { Config } from './types'
import { ERR_INVALID_PARAMS, ERR_SERVER, makeError, makeResult, type RpcRequest, type RpcResponse } from './rpc'
import { checksumAddress, hexToBytes, isHex, toAddress, toBigInt, toQuantity, type Hex } from './lib/hex'
import { messageChainName, recoverMessageSigner } from './lib/eip191'
import { IMPORT_CHAINS, importChain, readNativeBalance, type ImportChain } from './lib/import_chains'

/** Persisted under "import:<addrKey>" — one per account, forever. */
export interface ImportRecord {
  chainId: Hex
  /** Native balance read on the source chain, wei. */
  balance: Hex
  /** What was credited: balance × multiplier. */
  credit: Hex
  signature: Hex
  /** Unix ms. */
  at: number
}

export interface ImportDeps {
  imported: (addr: Hex) => ImportRecord | undefined
  /** Add `credit` to the account's sandbox balance and store the record; resolves to the new balance. */
  credit: (addr: Hex, credit: bigint, record: ImportRecord) => Promise<bigint>
  readBalance?: (chain: ImportChain, addr: Hex) => Promise<bigint>
  now?: () => number
}

export function importMessage(targetChain: string, account: Hex, chain: ImportChain): string {
  return [
    `Fakereum Import to ${targetChain}`,
    `Account: ${checksumAddress(account)}`,
    `From: ${chain.name} (chain id ${chain.chainId})`,
  ].join('\n')
}

/** Source chains for this sandbox: every supported chain except its own upstream. */
export function importSources(cfg: Config): ImportChain[] {
  return IMPORT_CHAINS.filter((c) => c.chainId !== cfg.upstreamChainId)
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function firstParam(req: RpcRequest): unknown {
  const p = req.params
  return Array.isArray(p) && p.length > 0 ? p[0] : undefined
}

function parseChainId(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return BigInt(v)
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return toBigInt(v)
  return null
}

function parseAccountAndChain(
  req: RpcRequest,
  cfg: Config,
): { account: Hex; chain: ImportChain } | { error: string } {
  const p = firstParam(req)
  if (!p || typeof p !== 'object') return { error: 'expected [{account, chainId, …}]' }
  const o = p as Record<string, unknown>
  if (typeof o['account'] !== 'string' || !ADDRESS_RE.test(o['account'])) {
    return { error: 'account must be a 20-byte 0x address' }
  }
  const chainId = parseChainId(o['chainId'])
  if (chainId === null) return { error: 'chainId must be a positive integer (decimal or 0x-hex)' }
  const chain = importChain(chainId)
  if (!chain) {
    return { error: `chain ${chainId} is not an import source; supported: ${IMPORT_CHAINS.map((c) => c.chainId).join(', ')}` }
  }
  if (chain.chainId === cfg.upstreamChainId) {
    return { error: `${chain.name} is this sandbox's upstream — its balance is imported automatically (× ${cfg.balanceMultiplier})` }
  }
  return { account: toAddress(o['account']), chain }
}

export async function rpcImportSources(req: RpcRequest, cfg: Config, deps: ImportDeps): Promise<RpcResponse> {
  const p = firstParam(req)
  if (typeof p !== 'string' || !ADDRESS_RE.test(p)) return makeError(req.id, ERR_INVALID_PARAMS, 'expected [address]')
  const account = toAddress(p)
  const read = deps.readBalance ?? readNativeBalance
  const sources = await Promise.all(
    importSources(cfg).map(async (c) => {
      const base = { chainId: toQuantity(c.chainId), name: c.name, symbol: c.symbol }
      try {
        const balance = await read(c, account)
        return { ...base, balance: toQuantity(balance), credit: toQuantity(balance * cfg.balanceMultiplier) }
      } catch (e) {
        return { ...base, error: String((e as Error).message ?? e) }
      }
    }),
  )
  return makeResult(req.id, {
    account: checksumAddress(account),
    multiplier: cfg.balanceMultiplier.toString(),
    imported: deps.imported(account) ?? null,
    sources,
  })
}

export function rpcImportMessage(req: RpcRequest, cfg: Config): RpcResponse {
  const parsed = parseAccountAndChain(req, cfg)
  if ('error' in parsed) return makeError(req.id, ERR_INVALID_PARAMS, parsed.error)
  return makeResult(req.id, { message: importMessage(messageChainName(cfg), parsed.account, parsed.chain) })
}

export async function rpcImportBalance(req: RpcRequest, cfg: Config, deps: ImportDeps): Promise<RpcResponse> {
  const parsed = parseAccountAndChain(req, cfg)
  if ('error' in parsed) return makeError(req.id, ERR_INVALID_PARAMS, parsed.error)
  const { account, chain } = parsed
  const signature = (firstParam(req) as Record<string, unknown>)['signature']
  if (typeof signature !== 'string' || !isHex(signature) || hexToBytes(signature).length !== 65) {
    return makeError(req.id, ERR_INVALID_PARAMS, 'signature must be 65 bytes of 0x-hex')
  }

  const prior = deps.imported(account)
  if (prior) {
    return makeError(
      req.id,
      ERR_SERVER,
      `account ${checksumAddress(account)} already imported its balance from chain ${toBigInt(prior.chainId)}; an account can import once`,
    )
  }

  let signer: Hex
  try {
    signer = await recoverMessageSigner(importMessage(messageChainName(cfg), account, chain), signature)
  } catch (e) {
    return makeError(req.id, ERR_INVALID_PARAMS, `cannot recover signer: ${String((e as Error).message ?? e)}`)
  }
  if (signer !== account) {
    return makeError(req.id, ERR_SERVER, `signature is from ${checksumAddress(signer)}, not ${checksumAddress(account)}`)
  }

  try {
    const balance = await (deps.readBalance ?? readNativeBalance)(chain, account)
    if (balance === 0n) {
      return makeError(req.id, ERR_SERVER, `${checksumAddress(account)} holds no ${chain.symbol} on ${chain.name}; nothing to import`)
    }
    const credit = balance * cfg.balanceMultiplier
    const record: ImportRecord = {
      chainId: toQuantity(chain.chainId),
      balance: toQuantity(balance),
      credit: toQuantity(credit),
      signature: signature as Hex,
      at: (deps.now ?? Date.now)(),
    }
    const newBalance = await deps.credit(account, credit, record)
    return makeResult(req.id, {
      account: checksumAddress(account),
      chainId: record.chainId,
      chain: chain.name,
      balance: record.balance,
      credit: record.credit,
      newBalance: toQuantity(newBalance),
    })
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}
