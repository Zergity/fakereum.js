// Admin-gated impersonation + clear RPCs. The (impersonator, impersonatee) /
// (include, exclude) scope is signed EIP-712; the recovered signer must be a
// configured admin. Disabled when no admins are set. Ports impersonate_rpc.go +
// clear_sandbox.go (verification half — the mutation half is injected by the DO).

import type { Config } from '../types'
import {
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_SERVER,
  makeError,
  makeResult,
  type RpcRequest,
  type RpcResponse,
} from '../rpc'
import { addrEq, checksumAddress, hexToBytes, toAddress, type Hex } from '../lib/hex'
import {
  clearSandboxDigest,
  recoverEIP712Signer,
  removeImpersonatorDigest,
  setCodeDigest,
  setImpersonatorDigest,
} from '../lib/eip712'
import type { Impersonators } from './store'

function isAdmin(cfg: Config, signer: Hex): boolean {
  return cfg.admins.some((a) => addrEq(a, signer))
}

function firstParam(req: RpcRequest): Record<string, unknown> | null {
  const params = req.params
  if (!Array.isArray(params) || params.length === 0) return null
  const p = params[0]
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
}

export function rpcListImpersonators(req: RpcRequest, im: Impersonators): RpcResponse {
  return makeResult(req.id, im.inverted())
}

export async function rpcSetImpersonator(
  req: RpcRequest,
  cfg: Config,
  im: Impersonators,
  persist: () => Promise<void>,
): Promise<RpcResponse> {
  if (cfg.admins.length === 0) {
    return makeError(req.id, ERR_METHOD_NOT_FOUND, 'impersonation is not enabled (no admins configured)')
  }
  const p = firstParam(req)
  if (!p || typeof p['impersonator'] !== 'string' || typeof p['impersonatee'] !== 'string' || typeof p['signature'] !== 'string') {
    return makeError(req.id, ERR_INVALID_PARAMS, 'expected [{impersonator,impersonatee,signature}]')
  }
  const impersonator = toAddress(p['impersonator'])
  const impersonatee = toAddress(p['impersonatee'])
  try {
    const digest = setImpersonatorDigest(cfg.chainId, impersonator, impersonatee)
    const signer = await recoverEIP712Signer(digest, p['signature'] as Hex)
    if (!isAdmin(cfg, signer)) return makeError(req.id, ERR_SERVER, `signer ${signer} is not an admin`)
    im.set(impersonator, impersonatee)
    await persist()
    return makeResult(req.id, true)
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}

export async function rpcRemoveImpersonator(
  req: RpcRequest,
  cfg: Config,
  im: Impersonators,
  persist: () => Promise<void>,
): Promise<RpcResponse> {
  if (cfg.admins.length === 0) {
    return makeError(req.id, ERR_METHOD_NOT_FOUND, 'impersonation is not enabled (no admins configured)')
  }
  const p = firstParam(req)
  if (!p || typeof p['impersonator'] !== 'string' || typeof p['signature'] !== 'string') {
    return makeError(req.id, ERR_INVALID_PARAMS, 'expected [{impersonator,signature}]')
  }
  const impersonator = toAddress(p['impersonator'])
  try {
    const digest = removeImpersonatorDigest(cfg.chainId, impersonator)
    const signer = await recoverEIP712Signer(digest, p['signature'] as Hex)
    if (!isAdmin(cfg, signer)) return makeError(req.id, ERR_SERVER, `signer ${signer} is not an admin`)
    if (!im.remove(impersonator)) {
      return makeError(req.id, ERR_SERVER, 'no impersonation mapping for that address')
    }
    await persist()
    return makeResult(req.id, true)
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}

const HEX_BYTES_RE = /^0x([0-9a-fA-F]{2})*$/

/**
 * Replace an existing contract's bytecode via an overlay code override. The
 * (account, code) pair is signed EIP-712 and the recovered signer must be a
 * configured admin. Works for both upstream and sandbox contracts — the
 * override sits in front of every code read. Injects the mutation via setCodeFn.
 */
export async function rpcSetCode(
  req: RpcRequest,
  cfg: Config,
  setCodeFn: (account: Hex, code: Uint8Array) => Promise<void>,
): Promise<RpcResponse> {
  if (cfg.admins.length === 0) {
    return makeError(req.id, ERR_METHOD_NOT_FOUND, 'set code is not enabled (no admins configured)')
  }
  const p = firstParam(req)
  if (
    !p ||
    typeof p['account'] !== 'string' ||
    typeof p['code'] !== 'string' ||
    typeof p['signature'] !== 'string'
  ) {
    return makeError(req.id, ERR_INVALID_PARAMS, 'expected [{account,code,signature}]')
  }
  if (!HEX_BYTES_RE.test(p['code'])) {
    return makeError(req.id, ERR_INVALID_PARAMS, 'code must be 0x-prefixed even-length hex')
  }
  const account = toAddress(p['account'])
  const code = hexToBytes(p['code'])
  try {
    const digest = setCodeDigest(cfg.chainId, account, code)
    const signer = await recoverEIP712Signer(digest, p['signature'] as Hex)
    if (!isAdmin(cfg, signer)) return makeError(req.id, ERR_SERVER, `signer ${signer} is not an admin`)
    await setCodeFn(account, code)
    return makeResult(req.id, { account: checksumAddress(account), codeSize: code.length })
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}

export interface ClearCounts {
  overlayCleared: number
  txsCleared: number
}

export async function rpcClearSandbox(
  req: RpcRequest,
  cfg: Config,
  clearFn: (include: Hex[], exclude: Hex[]) => Promise<ClearCounts>,
): Promise<RpcResponse> {
  if (cfg.admins.length === 0) {
    return makeError(req.id, ERR_METHOD_NOT_FOUND, 'clear sandbox is not enabled (no admins configured)')
  }
  const p = firstParam(req)
  if (!p || typeof p['signature'] !== 'string') {
    return makeError(req.id, ERR_INVALID_PARAMS, 'expected [{include?:address[], exclude?:address[], signature}]')
  }
  const include = toAddrArray(p['include'])
  const exclude = toAddrArray(p['exclude'])
  try {
    const digest = clearSandboxDigest(cfg.chainId, include, exclude)
    const signer = await recoverEIP712Signer(digest, p['signature'] as Hex)
    if (!isAdmin(cfg, signer)) return makeError(req.id, ERR_SERVER, `signer ${signer} is not an admin`)
    const counts = await clearFn(include, exclude)
    return makeResult(req.id, counts)
  } catch (e) {
    return makeError(req.id, ERR_SERVER, String((e as Error).message ?? e))
  }
}

function toAddrArray(v: unknown): Hex[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string').map(toAddress)
}
