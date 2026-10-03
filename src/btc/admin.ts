// Admin authorisation for the Bitcoin sandbox. An admin action is a canonical
// text message; the admin signs it with a wallet (BIP-322 simple) and the RPC
// carries the signature. The server rebuilds the same message from the request
// fields, so a signature only ever authorises exactly what it was shown.

import { addressToScript, scriptToAddress, type Network } from './address'
import { bytesToHex } from './bytes'
import { verifyBip322 } from './bip322'
import { BtcError } from './ledger'

export type AdminAction = 'clearSandbox' | 'setImpersonator' | 'removeImpersonator' | 'setUiMode'

/** Request fields that make up each action's message, in message order. */
export const ADMIN_FIELDS: Record<AdminAction, string[]> = {
  clearSandbox: [],
  setImpersonator: ['impersonator', 'impersonatee'],
  removeImpersonator: ['impersonator'],
  setUiMode: ['upstream'],
}

export const ADMIN_MAX_VALIDITY_SEC = 3600
export const ADMIN_DEFAULT_VALIDITY_SEC = 600
const ERR_ADMIN = -32000

export function isAdminAction(a: unknown): a is AdminAction {
  return typeof a === 'string' && Object.hasOwn(ADMIN_FIELDS, a)
}

/** "Bitcoin" for mainnet, "Bitcoin testnet" etc. otherwise. */
export function networkLabel(net: Network): string {
  return net.name === 'mainnet' ? 'Bitcoin' : `Bitcoin ${net.name}`
}

/** The address in its canonical spelling for `net`, or null if it is not a valid one. */
export function canonAddress(addr: unknown, net: Network): string | null {
  if (typeof addr !== 'string') return null
  const script = addressToScript(addr.trim(), net)
  return script ? scriptToAddress(script, net) : null
}

export function adminMessage(net: Network, action: AdminAction, fields: Record<string, string>, deadline: number): string {
  const lines = [`Fakereum admin action on ${networkLabel(net)}`, `Action: ${action}`]
  for (const f of ADMIN_FIELDS[action]) {
    lines.push(`${f[0]!.toUpperCase()}${f.slice(1)}: ${fields[f]}`)
  }
  lines.push(`Deadline: ${deadline}`)
  return lines.join('\n')
}

/** Pull and validate the message fields of `action` out of an RPC parameter object. */
export function adminFields(net: Network, action: AdminAction, p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of ADMIN_FIELDS[action]) {
    const v = p[f]
    if (f === 'upstream') {
      if (typeof v !== 'boolean') throw new BtcError('upstream must be a boolean', -32602)
      out[f] = String(v)
      continue
    }
    const a = canonAddress(v, net)
    if (!a) throw new BtcError(`${f} must be a valid ${net.name} address`, -32602)
    out[f] = a
  }
  return out
}

/**
 * Check that `p` carries a fresh signature of `action` by a configured admin.
 * Returns the admin's address. `used` remembers accepted signatures so one
 * cannot be replayed inside its validity window.
 */
export function verifyAdmin(
  net: Network,
  admins: string[],
  action: AdminAction,
  p: Record<string, unknown>,
  nowSec: number,
  used: Set<string>,
): string {
  if (admins.length === 0) throw new BtcError('admin tools are not enabled (no admins configured)', -32601)
  const admin = canonAddress(p['admin'], net)
  if (!admin) throw new BtcError('admin must be a valid address', -32602)
  const signature = p['signature']
  if (typeof signature !== 'string' || signature === '') throw new BtcError('signature required', -32602)
  const deadline = p['deadline']
  if (!Number.isSafeInteger(deadline)) throw new BtcError('deadline must be a unix time in seconds', -32602)
  const dl = deadline as number
  if (dl < nowSec) throw new BtcError('signature has expired', ERR_ADMIN)
  if (dl > nowSec + ADMIN_MAX_VALIDITY_SEC) throw new BtcError('deadline is too far in the future', ERR_ADMIN)

  const adminScripts = new Set(admins.map((a) => addressToScript(a, net)).filter((s) => s).map((s) => bytesToHex(s!)))
  if (!adminScripts.has(bytesToHex(addressToScript(admin, net)!))) throw new BtcError(`${admin} is not an admin`, ERR_ADMIN)

  const message = adminMessage(net, action, adminFields(net, action, p), dl)
  const why = verifyBip322(admin, net, message, signature)
  if (why) throw new BtcError('bad admin signature: ' + why, ERR_ADMIN)
  if (used.has(signature)) throw new BtcError('signature was already used', ERR_ADMIN)
  used.add(signature)
  return admin
}
