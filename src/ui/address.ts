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
import { deployLabel, esc, explorerCSS } from './html'

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

const SANDBOX_PILL = '<span class="pill sandbox">sandbox</span>'

/** code 0x-hex (empty / "0x" means EOA). */
function codeBytesLen(code: Hex | undefined): number {
  if (!code) return 0
  const h = code.startsWith('0x') || code.startsWith('0X') ? code.slice(2) : code
  return Math.floor(h.length / 2)
}

export function renderAddressPage(opts: RenderAddressOptions): string {
  const { cfg, overlay, upstream, txs, explorer, baseURL } = opts
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
  const parts: string[] = []

  parts.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox address ${esc(address.slice(0, 10))}…</title>
<style>${explorerCSS}
  .pill { display:inline-block; padding:.1em .55em; border-radius:999px; font-size:.75rem; border:1px solid #30363d; color:#7d8590; margin-left:.4em; vertical-align:middle; }
  .pill.sandbox { color:#d2a8ff; border-color:#6e40c9; }
  table { width:100%; border-collapse: collapse; margin: .5rem 0 1.5rem; font-size:.85rem; }
  table th, table td { border-bottom:1px solid #30363d; padding:.4rem .5rem; text-align:left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table th { color:#7d8590; font-weight:normal; font-family: ui-sans-serif, system-ui, sans-serif; }
  table tr:hover { background:#161b22; }
  .sig { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.82rem; color:#a5d6ff; }
  ul.sigs { padding-left:1.1rem; margin:.25rem 0 1rem; }
</style>
</head>
<body>
  <div class="nav"><a href="${esc(baseURL)}/">&larr; fakereum</a></div>
  <div class="tag">sandbox address · ${esc(cfg.networkName)} (chain ${esc(cfg.chainId.toString())})${isContract ? ' · contract' : ' · EOA'}</div>
  <h1>${esc(address)}${hasOverlay ? SANDBOX_PILL : ''}${selfDestructed ? '<span class="pill err">self-destructed</span>' : ''}</h1>
`)

  parts.push(`
  <dl>
    <dt>Balance (wei)</dt> <dd>${esc(balance)}${balanceSet ? ' ' + SANDBOX_PILL : upstreamScaleNote}</dd>
    <dt>Nonce</dt>         <dd>${esc(nonce)}${nonceSet ? ' ' + SANDBOX_PILL : ''}</dd>
    <dt>Code size</dt>     <dd>${esc(codeSize.toString())} bytes${codeSet ? ' ' + SANDBOX_PILL : ''}</dd>
    <dt>Type</dt>          <dd>${isContract ? 'contract' : 'EOA'}</dd>
    <dt>View on</dt>       <dd><a href="${esc(explorerURL)}" rel="noopener noreferrer">${esc(explorer.name)} &rarr;</a> <span class="muted">(${esc(upstreamName)}${upstreamId ? ' · id ' + esc(upstreamId.toString()) : ''})</span></dd>
  </dl>
`)

  // --- overlay storage ------------------------------------------------------
  if (storageRows.length > 0) {
    const rows = storageRows
      .map((s) => `<tr><td>${esc(s.key)}</td><td>${esc(s.value)}</td></tr>`)
      .join('')
    parts.push(`
  <div class="tag">sandbox storage (${esc(storageRows.length.toString())} slot${storageRows.length !== 1 ? 's' : ''})</div>
    <table>
      <thead><tr><th>slot</th><th>value</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
`)
  }

  // --- sandbox transactions -------------------------------------------------
  parts.push(`
  <div class="tag">sandbox transactions (${esc(txRows.length.toString())})</div>
`)
  if (txRows.length > 0) {
    const rows = txRows
      .map(
        (t) => `
          <tr>
            <td><a href="${esc(t.url)}">${esc(t.hash.slice(0, 12))}…</a></td>
            <td>${esc(t.role)}</td>
            <td class="${t.statusOK ? 'ok' : 'err'}">${esc(t.status)}</td>
            <td>${esc(t.block)}</td>
            <td>${esc(t.gasUsed)}</td>
          </tr>`,
      )
      .join('')
    parts.push(`
    <table>
      <thead><tr><th>tx</th><th>role</th><th>status</th><th>block</th><th>gas used</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
`)
  } else {
    parts.push(`
    <p class="muted">no sandbox transactions touch this address.</p>
`)
  }

  // --- code -----------------------------------------------------------------
  if (isContract) {
    parts.push(`
    <details>
      <summary>Code (${esc(codeSize.toString())} bytes)</summary>
      <pre>${esc(code ?? '')}</pre>
    </details>
`)
  }

  parts.push(`</body>
</html>`)

  return parts.join('')
}
