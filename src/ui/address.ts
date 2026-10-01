// Address detail page (GET /address/<addr>). Faithful port of
// address_explorer.go's renderAddress + addressExplorerTmpl.
//
// Surfaces the sandbox-effective view of an account: overlay values win when
// set, otherwise upstream@latest. Each field is flagged when it is
// sandbox-overridden. Lists sandbox txs that touch the address and the overlay
// storage slots. Links out to the upstream block explorer.

import type { Config, OverlayAccount, StoredTx } from '../types'
import type { Hex } from '../lib/hex'
import { addrEq, addrKey, checksumAddress, toBigInt } from '../lib/hex'
import { resolveDeployMethod } from '../lib/deploy'
import type { UpstreamExplorer } from '../lib/chains'
import { chainName } from '../lib/chains'
import { deployLabel, esc, identity, renderShell } from './html'

export interface RenderAddressOptions {
  address: Hex
  cfg: Config
  overlay: OverlayAccount | null
  /** Upstream@latest fallthrough values (QUANTITY hex), used when the overlay
   *  does not set the corresponding field. */
  upstream: { balance?: Hex; nonce?: Hex; code?: Hex }
  txs: StoredTx[]
  explorer: UpstreamExplorer
  baseURL: string
}

interface StorageRow {
  key: string
  value: string
}

interface TxRow {
  hash: Hex
  url: string
  role: string // "from" / "to" / "creator"
  status: string
  statusOK: boolean
  block: string
  gasUsed: string
}

const SANDBOX_PILL = '<span class="badge local">sandbox</span>'

/** code 0x-hex (empty / "0x" means EOA). */
function codeBytesLen(code: Hex | undefined): number {
  if (!code) return 0
  const h = code.startsWith('0x') || code.startsWith('0X') ? code.slice(2) : code
  return Math.floor(h.length / 2)
}

export function renderAddressPage(opts: RenderAddressOptions): string {
  const { cfg, overlay, upstream, txs, explorer, baseURL } = opts
  const id = identity(cfg)
  const wl = id.whitelabel
  const PILL = wl ? '' : SANDBOX_PILL
  const address = checksumAddress(opts.address)

  // --- effective account: overlay wins per-field, else upstream@latest ------
  const balanceSet = overlay?.balance != null
  const nonceSet = overlay?.nonce != null
  const codeSet = overlay?.code != null

  const balanceHex = balanceSet ? overlay!.balance! : upstream.balance
  const nonceHex = nonceSet ? overlay!.nonce! : upstream.nonce
  const codeHex = codeSet ? overlay!.code! : upstream.code

  // Balance rendered as decimal wei (Go: big.Int.String()). Without a sandbox
  // balance the figure is the upstream balance scaled by the multiplier.
  const balance = toBigInt(balanceHex ?? '0x0').toString()
  const upstreamScaleNote =
    opts.cfg.balanceMultiplier > 1n
      ? ` <span class="muted">(upstream × ${esc(opts.cfg.balanceMultiplier.toString())})</span>`
      : ''
  const nonce = toBigInt(nonceHex ?? '0x0').toString()
  const code: Hex | undefined = codeHex
  const codeSize = codeBytesLen(code)
  const isContract = codeSize > 0

  const hasOverlay = overlay != null
  const selfDestructed = overlay?.selfDestructed === true

  // --- overlay storage slots (sorted by key) --------------------------------
  const storageRows: StorageRow[] = []
  if (overlay?.storage) {
    for (const k of Object.keys(overlay.storage)) {
      storageRows.push({ key: k, value: overlay.storage[k]! })
    }
    storageRows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  // --- sandbox txs touching this address ------------------------------------
  const txRows: TxRow[] = []
  for (const tx of txs) {
    const statusOK = tx.status === 1
    // "creator" here means this address WAS created by the tx; annotate with the
    // deploy mechanism (CREATE / CREATE2).
    const creatorRole = () => `creator (${deployLabel(resolveDeployMethod(tx, addrKey(address)))})`
    let role = ''
    if (tx.contractAddress != null && addrEq(tx.contractAddress, address)) {
      role = creatorRole()
    } else if (addrEq(tx.from, address)) {
      role = 'from'
    } else if (tx.to != null && addrEq(tx.to, address)) {
      role = 'to'
    } else {
      for (const c of tx.createdContracts) {
        if (addrEq(c, address)) {
          role = creatorRole()
          break
        }
      }
    }
    txRows.push({
      hash: tx.hash,
      url: baseURL + '/tx/' + tx.hash,
      role,
      status: statusOK ? 'Success' : 'Reverted',
      statusOK,
      block: toBigInt(tx.blockNumber).toString(),
      gasUsed: toBigInt(tx.gasUsed).toString(),
    })
  }

  const upstreamId = cfg.upstreamChainId
  const upstreamName = chainName(upstreamId)
  const explorerURL = explorer.base + '/address/' + address

  // ------------------------------------------------------------------ markup
  const row = (k: string, v: string) => `      <dl class="kv"><dt>${k}:</dt><dd>${v}</dd></dl>\n`
  const parts: string[] = []

  parts.push(`  <div class="card"><div class="hd">Overview ${isContract ? '<span class="badge">Contract</span>' : '<span class="badge">EOA</span>'}${hasOverlay ? PILL : ''}${selfDestructed ? '<span class="badge err">self-destructed</span>' : ''}</div>
    <div class="bd">
${row('Balance', `${esc(balance)} <span class="muted">wei</span>${balanceSet ? ' ' + PILL : wl ? '' : upstreamScaleNote}`)}${row('Nonce', `${esc(nonce)}${nonceSet ? ' ' + PILL : ''}`)}${row('Code size', `${esc(codeSize.toString())} bytes${codeSet ? ' ' + PILL : ''}`)}${wl ? '' : row(
    'View on',
    `<a href="${esc(explorerURL)}" rel="noopener noreferrer">${esc(explorer.name)} &rarr;</a> <span class="muted">(${esc(upstreamName)}${upstreamId ? ' · id ' + esc(upstreamId.toString()) : ''})</span>`,
  )}    </div>
  </div>
`)

  // --- sandbox transactions -------------------------------------------------
  if (txRows.length > 0) {
    const rows = txRows
      .map(
        (t) => `
          <tr>
            <td><a class="mono" href="${esc(t.url)}">${esc(t.hash.slice(0, 14))}…</a></td>
            <td>${esc(t.block)}</td>
            <td><span class="badge">${esc(t.role)}</span></td>
            <td>${t.statusOK ? '<span class="badge ok">Success</span>' : '<span class="badge err">Reverted</span>'}</td>
            <td class="num">${esc(t.gasUsed)}</td>
          </tr>`,
      )
      .join('')
    parts.push(`  <div class="card">
    <div class="hd">${wl ? 'Transactions' : 'Sandbox transactions'} <span class="muted">(${esc(txRows.length.toString())})</span></div>
    <div class="tablewrap"><table class="list">
      <thead><tr><th>Txn hash</th><th>Block</th><th>Role</th><th>Status</th><th class="num">Gas used</th></tr></thead>
      <tbody>${rows}
      </tbody>
    </table></div>
  </div>
`)
  } else {
    parts.push(`  <div class="card"><div class="hd">${wl ? 'Transactions' : 'Sandbox transactions'}</div><div class="empty">No ${wl ? '' : 'sandbox '}transactions touch this address.</div></div>
`)
  }

  // --- overlay storage ------------------------------------------------------
  if (storageRows.length > 0 && !wl) {
    const rows = storageRows
      .map((s) => `<tr><td class="wrap mono">${esc(s.key)}</td><td class="wrap mono">${esc(s.value)}</td></tr>`)
      .join('')
    parts.push(`  <div class="card">
    <div class="hd">Sandbox storage <span class="muted">(${esc(storageRows.length.toString())} slot${storageRows.length !== 1 ? 's' : ''})</span></div>
    <div class="tablewrap"><table class="list">
      <thead><tr><th>Slot</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>
`)
  }

  // --- code -----------------------------------------------------------------
  if (isContract) {
    parts.push(`  <div class="card"><div class="pad">
    <details>
      <summary>Contract bytecode (${esc(codeSize.toString())} bytes)</summary>
      <pre>${esc(code ?? '')}</pre>
    </details>
  </div></div>
`)
  }

  return renderShell({
    title: wl ? `Address ${address.slice(0, 10)}…` : `Sandbox address ${address.slice(0, 10)}…`,
    heading: isContract ? 'Contract' : 'Address',
    sub: address,
    ...id,
    baseURL,
    body: parts.join(''),
  })
}
