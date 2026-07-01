// List pages: GET /txs (all sandbox txs, newest first) and GET /accounts
// (all overlay accounts). Faithful port of lists.go.
//
// Go uses html/template auto-escaping; here we interpolate with esc() on every
// data value. CSS is the shared explorerCSS plus the page-local listCSS below
// (verbatim from lists.go's listCSS constant).

import type { Config, DeployMethod, OverlayAccount, StoredTx } from '../types'
import { type Hex, addrKey, checksumAddress, strip0x, toBigInt } from '../lib/hex'
import { resolveDeployMethod } from '../lib/deploy'
import type { UpstreamExplorer } from '../lib/chains'
import { deployLabel, esc, explorerCSS } from './html'

// Page-local CSS — verbatim from lists.go's listCSS constant.
const listCSS = `
  table { width:100%; border-collapse: collapse; margin: .5rem 0 1.5rem; font-size:.85rem; }
  table th, table td { border-bottom:1px solid #30363d; padding:.45rem .55rem; text-align:left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table th { color:#7d8590; font-weight:normal; font-family: ui-sans-serif, system-ui, sans-serif; white-space:nowrap; }
  table tr:hover { background:#161b22; }
  table td.num { text-align:right; }
  .pill { display:inline-block; padding:.05em .45em; border-radius:999px; font-size:.7rem; border:1px solid #30363d; color:#7d8590; margin-left:.3em; vertical-align:middle; }
  .pill.sandbox { color:#d2a8ff; border-color:#6e40c9; }
  .dash { color:#484f58; }
  .reason { display:block; font-size:.75rem; color:#f85149; max-width:24rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`

// --------------------------------------------------------------------------
// humanizeAgo — formats a unix timestamp (seconds) as a short "Ns/m/h/d ago"
// string relative to `now` (seconds). Returns "" for ts==0 (the Go template
// then renders the em-dash), matching lists.go where TimeRel is empty when the
// block context is unknown. Verbatim bucket boundaries from lists.go.
// --------------------------------------------------------------------------
function humanizeAgo(ts: number, now: number): string {
  if (ts === 0) return ''
  const d = now - ts
  if (d < 0) {
    // Sandbox block timestamps can be a hair ahead of wall clock when the
    // upstream block we forked the context from was very recent.
    return 'just now'
  }
  if (d < 5) return 'just now'
  if (d < 60) return `${d}s ago`
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 30 * 86400) return `${Math.floor(d / 86400)}d ago`
  return `${Math.floor(d / (30 * 86400))}mo ago`
}

// time.Unix(ts,0).UTC().Format("2006-01-02 15:04:05 UTC")
function formatAbsUTC(ts: number): string {
  const dt = new Date(ts * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ` +
    `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())} UTC`
  )
}

// Go's `{{slice .Hash 0 n}}…`: take the first n characters then append an
// ellipsis. Operates on the already-checksummed hex string.
function slicePrefix(s: string, n: number): string {
  return s.slice(0, n) + '…'
}

// Compact deploy badges for a tx row: one pill per top-level deploy plus one per
// distinct internal-deploy method, each with a count when >1 (e.g. "CREATE2 ×2").
// Returns "" when the tx deploys nothing. `esc` is applied to every label; the
// pill markup itself is static.
function deployPillsForList(tx: StoredTx): string {
  let out = ''
  if (tx.contractAddress != null) {
    const method = resolveDeployMethod(tx, addrKey(tx.contractAddress))
    out += `<span class="pill deploy">${esc(deployLabel(method))}</span>`
  }

  // Internal (factory/CREATE2) deploys = createdContracts minus the top-level.
  const topLevel = tx.contractAddress ? strip0x(tx.contractAddress).toLowerCase() : null
  const counts = new Map<DeployMethod, number>()
  for (const c of tx.createdContracts) {
    if (topLevel !== null && strip0x(c).toLowerCase() === topLevel) continue
    const m = resolveDeployMethod(tx, addrKey(c))
    counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  // Stable order: CREATE2 first (the point of interest), then the CREATE forms.
  for (const m of ['create2', 'create', 'tx'] as const) {
    const n = counts.get(m)
    if (!n) continue
    out += `<span class="pill deploy">${esc(deployLabel(m))}${n > 1 ? esc(` ×${n}`) : ''}</span>`
  }
  return out
}

const docHead = (title: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${explorerCSS}${listCSS}</style>
</head>`

// --------------------------------------------------------------------------
// GET /txs
// --------------------------------------------------------------------------

export interface RenderTxListOpts {
  txs: StoredTx[]
  cfg: Config
  explorer: UpstreamExplorer
  baseURL: string
}

interface TxListRow {
  hash: string
  url: string
  block: number // 0 when block-context unknown
  timeRel: string // "" when unknown -> em-dash
  timeAbs: string // tooltip; "" when unknown
  from: string
  fromURL: string
  to: string // "" when none
  toURL: string
  deployHTML: string // deploy badges (zero-address tx / CREATE / CREATE2); "" when none
  status: string
  statusOK: boolean
  reason: string // decoded revert reason (Error/Panic); custom errors on detail page
  gasUsed: bigint
}

export function renderTxList(opts: RenderTxListOpts): string {
  const { txs, cfg } = opts
  const now = Math.floor(Date.now() / 1000)

  // newest first: StoredTx.seq is monotonic (higher = newer).
  const sorted = [...txs].sort((a, b) => b.seq - a.seq)

  const rows: TxListRow[] = sorted.map((e) => {
    const hash = e.hash
    const from = checksumAddress(e.from)
    const statusOK = e.status === 1

    let to = ''
    let toURL = ''
    if (e.contractAddress != null) {
      const ca = checksumAddress(e.contractAddress)
      to = ca
      toURL = '/address/' + ca
    } else if (e.to != null) {
      const t = checksumAddress(e.to)
      to = t
      toURL = '/address/' + t
    }

    let status = 'Success'
    let reason = ''
    if (!statusOK) {
      status = 'Reverted'
      // Error(string)/Panic decode is precomputed and stored on the tx; custom
      // errors (which need the target ABI) are only shown on the detail page.
      reason = e.revertReason ?? ''
    }

    const blockNum = Number(toBigInt(e.blockNumber))
    const blockTime = Number(toBigInt(e.blockTime))
    const timeRel = humanizeAgo(blockTime, now)
    const timeAbs = blockTime !== 0 ? formatAbsUTC(blockTime) : ''

    return {
      hash,
      url: '/tx/' + hash,
      block: blockNum,
      timeRel,
      timeAbs,
      from,
      fromURL: '/address/' + from,
      to,
      toURL,
      deployHTML: deployPillsForList(e),
      status,
      statusOK,
      reason,
      gasUsed: toBigInt(e.gasUsed),
    }
  })

  const networkName = cfg.networkName
  const chainID = cfg.chainId.toString()

  let body = `<body>
  <div class="nav"><a href="/">&larr; fakereum</a></div>
  <div class="tag">sandbox transactions · ${esc(networkName)} (chain ${esc(chainID)})</div>
  <h1 style="font-family:ui-sans-serif,system-ui,sans-serif">All sandbox transactions <span class="muted">(${rows.length})</span></h1>
`

  if (rows.length > 0) {
    body += `  <form method="post" action="/undo/last" style="display:inline; margin-bottom:.5rem;">
      <button type="submit" class="undo">Undo last tx</button>
    </form>
    <span class="muted" style="margin-left:.5rem; font-size:.85rem;">or click ↶ on any row to undo back to (and including) that tx</span>
    <table>
      <thead><tr><th>tx</th><th>age</th><th>block</th><th>from</th><th>to</th><th>status</th><th class="num">gas used</th><th></th></tr></thead>
      <tbody>
`
    for (const r of rows) {
      const ageCell = r.timeRel
        ? `<td${r.timeAbs ? ` title="${esc(r.timeAbs)}"` : ''}>${esc(r.timeRel)}</td>`
        : `<td${r.timeAbs ? ` title="${esc(r.timeAbs)}"` : ''}><span class="dash">—</span></td>`
      const blockCell = r.block ? `<td>${esc(r.block)}</td>` : `<td><span class="dash">—</span></td>`
      const toCell = r.to
        ? `<td><a href="${esc(r.toURL)}">${esc(slicePrefix(r.to, 10))}</a>${r.deployHTML}</td>`
        : `<td><span class="dash">—</span>${r.deployHTML}</td>`
      const statusCell = `<td class="${r.statusOK ? 'ok' : 'err'}">${esc(r.status)}${r.reason ? `<span class="reason" title="${esc(r.reason)}">${esc(r.reason)}</span>` : ''}</td>`
      body += `        <tr>
          <td><a href="${esc(r.url)}">${esc(slicePrefix(r.hash, 14))}</a></td>
          ${ageCell}
          ${blockCell}
          <td><a href="${esc(r.fromURL)}">${esc(slicePrefix(r.from, 10))}</a></td>
          ${toCell}
          ${statusCell}
          <td class="num">${esc(r.gasUsed.toString())}</td>
          <td><form method="post" action="/undo/${esc(r.hash)}" style="display:inline;" onsubmit="return confirm('Undo this tx and everything after it?');"><button type="submit" class="undo small" title="undo back to here">↶</button></form></td>
        </tr>
`
    }
    body += `      </tbody>
    </table>
`
  } else {
    body += `  <p class="muted">No sandbox transactions yet. Send one via <code>eth_sendRawTransaction</code> to populate this list.</p>
`
  }

  body += `</body>
</html>`

  return docHead(`Sandbox transactions · ${esc(networkName)}`) + '\n' + body
}

// --------------------------------------------------------------------------
// GET /accounts
// --------------------------------------------------------------------------

export interface RenderAccountListOpts {
  accounts: Array<{ address: Hex; acct: OverlayAccount }>
  cfg: Config
  baseURL: string
}

interface AccountListRow {
  address: string
  url: string
  balanceSet: boolean
  balance: string // decimal wei when balanceSet
  nonceSet: boolean
  nonce: string // decimal
  codeSet: boolean
  codeSize: number // bytes
  storageSlots: number
  selfDestruct: boolean
}

export function renderAccountList(opts: RenderAccountListOpts): string {
  const { accounts, cfg } = opts

  const rows: AccountListRow[] = accounts.map(({ address, acct }) => {
    const addr = checksumAddress(address)
    const balanceSet = acct.balance != null
    const nonceSet = acct.nonce != null
    const codeSet = acct.code != null
    // CodeSize: byte length of the overlay code (excludes the 0x prefix).
    const codeSize = codeSet ? strip0x(acct.code as string).length / 2 : 0
    const storageSlots = acct.storage ? Object.keys(acct.storage).length : 0
    return {
      address: addr,
      url: '/address/' + addr,
      balanceSet,
      balance: balanceSet ? toBigInt(acct.balance as string).toString() : '',
      nonceSet,
      nonce: nonceSet ? toBigInt(acct.nonce as string).toString() : '',
      codeSet,
      codeSize,
      storageSlots,
      selfDestruct: acct.selfDestructed === true,
    }
  })

  // sort by checksummed address string (matches Go's sort by Address.Hex()).
  rows.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))

  const networkName = cfg.networkName
  const chainID = cfg.chainId.toString()

  let body = `<body>
  <div class="nav"><a href="/">&larr; fakereum</a></div>
  <div class="tag">sandbox accounts · ${esc(networkName)} (chain ${esc(chainID)})</div>
  <h1 style="font-family:ui-sans-serif,system-ui,sans-serif">All sandbox accounts <span class="muted">(${rows.length})</span></h1>
  <p class="muted">Every address whose balance / nonce / code / storage has been touched in the sandbox (overlay state). Reads for addresses not listed here fall through to upstream.</p>
`

  if (rows.length > 0) {
    body += `  <table>
      <thead><tr><th>address</th><th>balance (wei)</th><th>nonce</th><th class="num">code</th><th class="num">slots</th><th></th></tr></thead>
      <tbody>
`
    for (const r of rows) {
      const balanceCell = r.balanceSet ? esc(r.balance) : `<span class="dash">—</span>`
      const nonceCell = r.nonceSet ? esc(r.nonce) : `<span class="dash">—</span>`
      const codeCell = r.codeSet ? `${esc(r.codeSize)}B` : `<span class="dash">—</span>`
      const slotsCell = r.storageSlots ? esc(r.storageSlots) : `<span class="dash">—</span>`
      const sdCell = r.selfDestruct ? `<span class="pill err">self-destructed</span>` : ''
      body += `        <tr>
          <td><a href="${esc(r.url)}">${esc(r.address)}</a></td>
          <td>${balanceCell}</td>
          <td>${nonceCell}</td>
          <td class="num">${codeCell}</td>
          <td class="num">${slotsCell}</td>
          <td>${sdCell}</td>
        </tr>
`
    }
    body += `      </tbody>
    </table>
`
  } else {
    body += `  <p class="muted">No sandbox accounts yet. They appear here when a sandbox tx (or <code>--genesis</code> seed) writes to balance, nonce, code, or storage.</p>
`
  }

  body += `</body>
</html>`

  return docHead(`Sandbox accounts · ${esc(networkName)}`) + '\n' + body
}
