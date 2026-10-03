// Server-rendered explorer pages for the BTC sandbox, styled after the mempool
// UI handoff. Pure functions over Esplora-shaped JSON: BtcNode gathers the data
// (sandbox rows merged with the real chain below the fork point) and these only
// lay it out. Everything interpolated into markup goes through esc().

import { esc, humanizeAgo } from '../ui/html'
import { BTC_CSS } from './ui_css'

export interface PageCtx {
  /** Network name, e.g. "mainnet". */
  network: string
  forked: boolean
  anchorHeight: number
  tipHeight: number
  tipTime: number
  now: number
  feeRate: number
  minRelayFeePerKvB: number
  faucetMaxSats: string
  /** Sample address for the faucet form's placeholder. */
  sampleAddress: string
  baseURL: string
  /** Upstream-appearance mode: no sandbox wording or sandbox-only controls. */
  whitelabel: boolean
  /** Admin tools are configured (ADMINS set). */
  adminEnabled: boolean
}

type J = any // Esplora JSON, shape-checked loosely: upstream objects carry extra fields.

const SAT = 100_000_000

/** Satoshis as a BTC string with trailing zeros trimmed (at least two decimals). */
export function fmtBtc(sats: number | bigint): string {
  const neg = BigInt(sats) < 0n
  const v = neg ? -BigInt(sats) : BigInt(sats)
  const whole = v / BigInt(SAT)
  const frac = (v % BigInt(SAT)).toString().padStart(8, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`
}

function btc(sats: number | bigint): string {
  return `${esc(fmtBtc(sats))}<span class="u"> BTC</span>`
}

function ago(ts: number, ctx: PageCtx): string {
  return esc(humanizeAgo(ts, ctx.now) || '—')
}

function utc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function short(h: string, n = 8): string {
  return h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h
}

function feeRate(fee: number, weight: number): string {
  if (!weight) return '—'
  const r = fee / (weight / 4)
  return r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2)
}

// --- shell -----------------------------------------------------------------------

type Tab = 'dash' | 'txs' | 'accounts' | 'admin' | 'api' | ''

function shell(ctx: PageCtx, title: string, body: string, active: Tab = ''): string {
  const tab = (id: Tab, href: string, label: string) =>
    `<a href="${href}"${active === id ? ' class="on" aria-current="page"' : ''}>${label}</a>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} · Fakereum BTC</title>
<style>${BTC_CSS}</style></head>
<body>
<nav class="top" aria-label="Main">
  <a class="logo" href="/" aria-label="Fakereum BTC home"><i aria-hidden="true"></i><span>fakereum<small>.btc</small></span></a>
  <div class="net"><b aria-hidden="true"></b>${esc(ctx.network)}${ctx.forked || ctx.whitelabel ? '' : ' · standalone'}</div>
  <div class="tabs">
    ${tab('dash', '/', 'Dashboard')}
    ${tab('txs', '/txs', 'Transactions')}
    ${ctx.whitelabel ? '' : tab('accounts', '/accounts', 'Accounts')}
    ${ctx.whitelabel || !ctx.adminEnabled ? '' : tab('admin', '/admin', 'Admin')}
    ${tab('api', '/fakereum', 'API')}
  </div>
  <form class="search" action="/search" method="get">
    <label for="q" hidden>Search</label>
    <input id="q" name="q" class="in" placeholder="Address, transaction, block height or hash" autocomplete="off" spellcheck="false">
    <button class="btn" type="submit" aria-label="Search">Search</button>
  </form>
</nav>
${body}
<footer>
  ${ctx.whitelabel ? '' : '<div><b>Sandbox</b><span>Nothing here reaches the real network.</span><span>Real outputs are spent with a signed message.</span></div>'}
  <div><b>Endpoints</b><a href="/api/blocks/tip/height">Esplora REST /api</a><span>JSON-RPC /rpc</span><a href="/fakereum">Discovery /fakereum</a></div>
  <div><b>Fork</b><span>${ctx.forked ? `Real chain up to block ${ctx.anchorHeight.toLocaleString('en-US')}` : 'Standalone chain'}</span></div>
</footer>
</body></html>`
}

export function errorPage(ctx: PageCtx, status: number, message: string): string {
  return shell(
    ctx,
    String(status),
    `<div class="wrap"><h1 class="page">${status === 404 ? 'Not found' : 'Something went wrong'}<small>${esc(message)}</small></h1></div>`,
  )
}

// --- dashboard ---------------------------------------------------------------------

function blockTile(b: J, ctx: PageCtx): string {
  const sandbox = b.height > ctx.anchorHeight
  const ex = b.extras ?? {}
  const median = typeof ex.medianFee === 'number' ? `~${Math.round(ex.medianFee)} sat/vB` : ''
  const range = Array.isArray(ex.feeRange) && ex.feeRange.length > 1 ? `${trimFee(ex.feeRange[0])} – ${trimFee(ex.feeRange.at(-1))} sat/vB` : ''
  const total = typeof ex.totalFees === 'number' ? `${esc(fmtBtc(ex.totalFees))} BTC fees` : `${esc(((b.size ?? 0) / 1000).toFixed(1))} kB`
  const label = sandbox ? (ctx.whitelabel ? '' : 'Sandbox') : ex.pool?.name ? String(ex.pool.name) : ''
  return `<a class="blk mined${sandbox ? '' : ' real'}" href="/block/${esc(b.id)}" aria-label="Block ${b.height}">
  <span class="h">${b.height}</span>
  <div class="body"><span>${esc(median)}</span><span class="range">${esc(range)}</span><span class="big">${total}</span><span class="tx">${(b.tx_count ?? 0).toLocaleString('en-US')} transaction${b.tx_count === 1 ? '' : 's'}</span><span class="time">${ago(b.timestamp, ctx)}</span></div>
  <span class="pool">${esc(label)}</span></a>`
}

function trimFee(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, '')
}

const FAUCET_SCRIPT = `<script>
document.getElementById('faucet').addEventListener('submit', async (e) => {
  e.preventDefault()
  const out = document.getElementById('faucet-out')
  const sats = Math.round(parseFloat(document.getElementById('f-amt').value) * 1e8)
  if (!(sats > 0)) { out.textContent = 'Enter a positive amount.'; return }
  out.textContent = 'Minting…'
  try {
    const r = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fakereum_faucet', params: [document.getElementById('f-addr').value.trim(), sats] }) })
    const j = await r.json()
    if (j.error) { out.textContent = j.error.message; return }
    const id = typeof j.result === 'string' ? j.result : (j.result && j.result.txid)
    out.textContent = ''
    if (id) { const a = document.createElement('a'); a.href = '/tx/' + id; a.textContent = id; out.append('Minted in ', a) }
    else out.textContent = JSON.stringify(j.result)
  } catch (err) { out.textContent = String(err) }
})
</script>`

function faucetCard(ctx: PageCtx): string {
  return `<div class="eyebrow" style="margin-top:30px">Faucet</div>
    <div class="card">
      <form class="faucet" id="faucet">
        <div class="row">
          <label for="f-addr" hidden>Address</label>
          <input id="f-addr" class="in" placeholder="${esc(ctx.sampleAddress)}" autocomplete="off" spellcheck="false" required>
          <label for="f-amt" hidden>Amount in BTC</label>
          <input id="f-amt" class="in" style="flex:0 1 120px" value="1" inputmode="decimal" aria-label="Amount in BTC" required>
          <button class="btn" type="submit">Mint</button>
        </div>
        <div id="faucet-out" role="status"></div>
        <small>Up to ${esc(fmtBtc(BigInt(ctx.faucetMaxSats)))} BTC per mint. Each mint is its own sandbox block.</small>
      </form>
    </div>`
}

export function dashboardPage(ctx: PageCtx, blocks: J[], txs: J[]): string {
  const next = `<div class="blk proj" aria-label="Next block"><div class="body"><span>${ctx.feeRate} sat/vB</span><span class="range">min ${(ctx.minRelayFeePerKvB / 1000).toString()} sat/vB</span><span class="big">0.00 BTC</span><span class="tx">0 transactions</span><span class="time">On the next tx</span></div></div>`
  const rows = txs
    .map((t) => {
      const total = (t.vout as J[]).reduce((n, o) => n + o.value, 0)
      const faucet = (t.vin as J[]).every((i) => !i.prevout)
      return `<tr><td><a class="mono" href="/tx/${esc(t.txid)}">${esc(short(t.txid, 6))}</a></td><td>${faucet ? `<span class="badge faucet">${ctx.whitelabel ? 'Transfer' : 'Faucet'}</span>` : `${esc(feeRate(t.fee, t.weight))}<span class="u"> sat/vB</span>`}</td><td>${btc(total)}</td><td><a href="/block/${esc(t.status.block_hash)}">${t.status.block_height}</a></td></tr>`
    })
    .join('')
  const body = `
<div class="strip"><div class="blocks">${next}<div class="divider" aria-hidden="true"></div>${blocks.map((b) => blockTile(b, ctx)).join('')}</div></div>
<div class="wrap">
<div class="grid">
  <div>
    <div class="eyebrow">Transaction fees</div>
    <div class="card">
      <div class="feebar"><div class="np">No Priority</div><div class="sep"></div><div class="pr"></div></div>
      <div class="stats">
        <div><div class="v">${ctx.minRelayFeePerKvB / 1000}<small>sat/vB</small></div><div class="l">Minimum relay</div></div>
        <div><div class="v">${ctx.feeRate}<small>sat/vB</small></div><div class="l">Estimate, any target</div></div>
      </div>
    </div>
    <div class="eyebrow" style="margin-top:30px">Recent transactions</div>
    <div class="card"><div class="scroll"><table class="t">
      <thead><tr><th>TXID</th><th>Fee / type</th><th>Amount</th><th>Block</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" style="text-align:center;color:var(--muted)">${ctx.whitelabel ? 'No recent transactions.' : 'No sandbox transactions yet. Mint some coins with the faucet.'}</td></tr>`}</tbody>
    </table></div></div>
  </div>
  <div>
    <div class="eyebrow">Chain</div>
    <div class="card">
      <div class="bar" aria-hidden="true"><i></i></div>
      <div class="stats">
        <div><div class="v">${ctx.tipHeight.toLocaleString('en-US')}</div><div class="l">Tip height</div></div>
        ${ctx.whitelabel ? '' : `<div><div class="v">${ctx.forked ? ctx.anchorHeight.toLocaleString('en-US') : 'none'}</div><div class="l">Fork point</div></div>
        <div><div class="v">${(ctx.tipHeight - ctx.anchorHeight).toLocaleString('en-US')}</div><div class="l">Sandbox blocks</div></div>`}
      </div>
    </div>
    ${ctx.whitelabel ? '' : faucetCard(ctx)}
  </div>
</div>
</div>
${ctx.whitelabel ? '' : FAUCET_SCRIPT}`
  return shell(ctx, 'Dashboard', body, 'dash')
}

// --- transactions --------------------------------------------------------------------

function addrCell(o: J): string {
  if (o.scriptpubkey_address) return `<a class="a" href="/address/${esc(o.scriptpubkey_address)}">${esc(o.scriptpubkey_address)}</a>`
  if (o.scriptpubkey_type === 'op_return') return '<span class="a">OP_RETURN</span>'
  return `<span class="a">${esc(o.scriptpubkey_type ?? 'unknown')}</span>`
}

function txCard(t: J, ctx: PageCtx, highlight?: string): string {
  const faucet = (t.vin as J[]).every((i) => !i.prevout) && !(t.vin as J[]).some((i) => i.is_coinbase)
  const ins = (t.vin as J[])
    .map((i) => {
      if (i.is_coinbase) return '<li><span class="a"><span class="badge cb">Coinbase</span></span><span class="n"></span></li>'
      if (!i.prevout) return `<li><span class="a"><span class="badge faucet">${ctx.whitelabel ? 'Minted' : 'Faucet mint'}</span></span><span class="n"></span></li>`
      const mark = i.prevout.scriptpubkey_address === highlight ? ' style="outline:1px solid var(--info)"' : ''
      return `<li${mark}>${addrCell(i.prevout)}<span class="n">${btc(i.prevout.value)}</span></li>`
    })
    .join('')
  const outs = (t.vout as J[])
    .map((o) => {
      const mark = o.scriptpubkey_address && o.scriptpubkey_address === highlight ? ' style="outline:1px solid var(--info)"' : ''
      return `<li${mark}>${addrCell(o)}<span class="n">${btc(o.value)}</span></li>`
    })
    .join('')
  const total = (t.vout as J[]).reduce((n, o) => n + o.value, 0)
  const conf = t.status?.confirmed ? ctx.tipHeight - t.status.block_height + 1 : 0
  return `<div class="txcard">
  <div class="txhead"><a class="mono" href="/tx/${esc(t.txid)}">${esc(t.txid)}</a><span>${t.status?.confirmed ? ago(t.status.block_time, ctx) : 'unconfirmed'}</span></div>
  <div class="io"><ul aria-label="Inputs">${ins}</ul><div class="arrow" aria-hidden="true">→</div><ul aria-label="Outputs">${outs}</ul></div>
  <div class="txfoot"><span>${faucet ? `<span class="badge faucet">${ctx.whitelabel ? 'Minted' : 'Faucet'}</span>` : `${esc(feeRate(t.fee, t.weight))}<span class="u"> sat/vB · ${esc(String(t.fee))} sat fee</span>`}</span>
  <span><span class="chip ${conf ? 'ok' : ''}">${conf ? `${conf.toLocaleString('en-US')} confirmation${conf === 1 ? '' : 's'}` : 'Unconfirmed'}</span> <span>${btc(total)}</span></span></div>
</div>`
}

export function txPage(ctx: PageCtx, t: J): string {
  const conf = t.status?.confirmed ? ctx.tipHeight - t.status.block_height + 1 : 0
  const vsize = Math.ceil(t.weight / 4)
  const sandbox = t.status?.confirmed && t.status.block_height > ctx.anchorHeight
  const body = `<div class="wrap">
<h1 class="page">Transaction ${sandbox && !ctx.whitelabel ? '<span class="badge sbx">sandbox</span>' : ''}<small class="mono">${esc(t.txid)}</small></h1>
<div class="card" style="margin:20px 0">
  <dl class="kv">
    <dt>Status</dt><dd>${t.status?.confirmed ? `<span class="chip ok">${conf.toLocaleString('en-US')} confirmation${conf === 1 ? '' : 's'}</span>` : '<span class="chip">Unconfirmed</span>'}</dd>
    ${t.status?.confirmed ? `<dt>Block</dt><dd><a href="/block/${esc(t.status.block_hash)}">${t.status.block_height.toLocaleString('en-US')}</a> · ${esc(utc(t.status.block_time))}</dd>` : ''}
    <dt>Fee</dt><dd>${esc(String(t.fee))} sat <span class="u">(${esc(feeRate(t.fee, t.weight))} sat/vB)</span></dd>
    <dt>Size</dt><dd>${t.size.toLocaleString('en-US')} B · ${vsize.toLocaleString('en-US')} vB · ${t.weight.toLocaleString('en-US')} WU</dd>
    <dt>Version / locktime</dt><dd>${t.version} / ${t.locktime}</dd>
    ${Array.isArray(t.fakereum_signed_by) && t.fakereum_signed_by.length && !ctx.whitelabel ? `<dt>Authorised by</dt><dd>Signed message from ${(t.fakereum_signed_by as string[]).map((a) => `<a href="/address/${esc(a)}">${esc(a)}</a>`).join(', ')}</dd>` : ''}
  </dl>
</div>
${txCard(t, ctx)}
</div>`
  return shell(ctx, `Transaction ${short(t.txid, 6)}`, body)
}

// --- blocks ----------------------------------------------------------------------------

export function blockPage(ctx: PageCtx, b: J, txs: J[], total: number): string {
  const sandbox = b.height > ctx.anchorHeight
  const conf = ctx.tipHeight - b.height + 1
  const ex = b.extras ?? {}
  const prev = b.previousblockhash
  const body = `<div class="wrap">
<div class="hdr"><h1 class="page">Block <a href="/block/${esc(b.id)}">${b.height.toLocaleString('en-US')}</a> ${sandbox && !ctx.whitelabel ? '<span class="badge sbx">sandbox</span>' : ''}<small class="mono">${esc(b.id)}</small></h1>
<div style="margin-top:34px;white-space:nowrap">${prev && b.height > 0 ? `<a href="/block/${esc(prev)}">← Previous</a>` : ''}${b.height < ctx.tipHeight ? ` · <a href="/block-height/${b.height + 1}">Next →</a>` : ''}</div></div>
<div class="card" style="margin:20px 0">
  <dl class="kv">
    <dt>Timestamp</dt><dd>${esc(utc(b.timestamp))} <span class="u">(${ago(b.timestamp, ctx)})</span></dd>
    <dt>Confirmations</dt><dd>${conf.toLocaleString('en-US')}</dd>
    <dt>Transactions</dt><dd>${(b.tx_count ?? 0).toLocaleString('en-US')}</dd>
    <dt>Size / weight</dt><dd>${(b.size ?? 0).toLocaleString('en-US')} B · ${(b.weight ?? 0).toLocaleString('en-US')} WU</dd>
    ${ex.pool?.name ? `<dt>Miner</dt><dd>${esc(ex.pool.name)}</dd>` : ''}
    ${typeof ex.totalFees === 'number' ? `<dt>Total fees</dt><dd>${btc(ex.totalFees)}</dd>` : ''}
    <dt>Merkle root</dt><dd class="mono">${esc(b.merkle_root)}</dd>
    <dt>Previous block</dt><dd class="mono">${prev ? `<a href="/block/${esc(prev)}">${esc(prev)}</a>` : '—'}</dd>
  </dl>
</div>
${txs.map((t) => txCard(t, ctx)).join('')}
${txs.length < total ? `<div class="note">Showing ${txs.length} of ${total.toLocaleString('en-US')} transactions.</div>` : ''}
${total === 0 ? '<div class="note">This block has no transactions.</div>' : ''}
</div>`
  return shell(ctx, `Block ${b.height}`, body)
}

// --- addresses --------------------------------------------------------------------------

export function addressPage(ctx: PageCtx, address: string, info: J, txs: J[]): string {
  const cs = info.chain_stats ?? {}
  const ms = info.mempool_stats ?? {}
  const balance = (cs.funded_txo_sum ?? 0) - (cs.spent_txo_sum ?? 0) + ((ms.funded_txo_sum ?? 0) - (ms.spent_txo_sum ?? 0))
  const body = `<div class="wrap">
<h1 class="page">Address<small class="mono">${esc(address)}</small></h1>
<div class="card" style="margin:20px 0">
  <dl class="kv">
    <dt>Balance</dt><dd>${btc(balance)}</dd>
    <dt>Total received</dt><dd>${btc(cs.funded_txo_sum ?? 0)} <span class="u">in ${(cs.funded_txo_count ?? 0).toLocaleString('en-US')} outputs</span></dd>
    <dt>Total sent</dt><dd>${btc(cs.spent_txo_sum ?? 0)} <span class="u">from ${(cs.spent_txo_count ?? 0).toLocaleString('en-US')} outputs</span></dd>
    <dt>Transactions</dt><dd>${(cs.tx_count ?? 0).toLocaleString('en-US')}</dd>
  </dl>
</div>
${txs.map((t) => txCard(t, ctx, address)).join('')}
${txs.length === 0 ? '<div class="note">No transactions for this address.</div>' : ''}
${(cs.tx_count ?? 0) > txs.length ? `<div class="note">Showing the latest ${txs.length} transactions. Page further through the API: <span class="mono">/api/address/${esc(address)}/txs/chain/&lt;last txid&gt;</span></div>` : ''}
</div>`
  return shell(ctx, `Address ${short(address, 6)}`, body)
}

// --- transaction and account lists -------------------------------------------------------

export function txListPage(ctx: PageCtx, txs: J[]): string {
  const rows = txs
    .map((t) => {
      const total = (t.vout as J[]).reduce((n, o) => n + o.value, 0)
      const faucet = (t.vin as J[]).every((i) => !i.prevout)
      const signed = Array.isArray(t.fakereum_signed_by) && t.fakereum_signed_by.length
      return `<tr><td><a class="mono" href="/tx/${esc(t.txid)}">${esc(short(t.txid, 8))}</a></td>
<td>${faucet ? `<span class="badge faucet">${ctx.whitelabel ? 'Minted' : 'Faucet'}</span>` : signed && !ctx.whitelabel ? '<span class="badge full">Signed msg</span>' : '<span class="badge">Transfer</span>'}</td>
<td>${btc(total)}</td><td>${faucet ? '—' : `${esc(feeRate(t.fee, t.weight))}<span class="u"> sat/vB</span>`}</td>
<td><a href="/block/${esc(t.status.block_hash)}">${t.status.block_height}</a></td><td>${ago(t.status.block_time, ctx)}</td>
${ctx.whitelabel ? '' : `<td><form method="post" action="/undo/${esc(t.txid)}"><button class="btn" style="height:28px;min-width:0;padding:0 10px;font-size:13px" title="Remove this transaction and everything after it">Undo</button></form></td>`}</tr>`
    })
    .join('')
  const body = `<div class="wrap">
<h1 class="page">Transactions<small>${ctx.whitelabel ? 'Recent transactions' : 'Every sandbox transaction, newest first. Undo removes a transaction and everything mined after it.'}</small></h1>
<div class="card" style="margin:20px 0"><div class="scroll"><table class="t">
<thead><tr><th>TXID</th><th>Type</th><th>Amount</th><th>Fee</th><th>Block</th><th>Age</th>${ctx.whitelabel ? '' : '<th></th>'}</tr></thead>
<tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:var(--muted)">No transactions yet.</td></tr>`}</tbody>
</table></div></div></div>`
  return shell(ctx, 'Transactions', body, 'txs')
}

export interface AccountRow {
  address: string
  balance: string
  txCount: number
  kind: string
  pinned: boolean
  impersonates?: string
}

export function accountsPage(ctx: PageCtx, rows: AccountRow[]): string {
  const body = `<div class="wrap">
<h1 class="page">Accounts<small>Addresses with sandbox activity. <b>Upstream</b> accounts have real-chain history and spend real outputs with a signed message; <b>sandbox</b> accounts spend sandbox coins with ordinary transactions.</small></h1>
<div class="card" style="margin:20px 0"><div class="scroll"><table class="t">
<thead><tr><th>Address</th><th>Sandbox balance</th><th>Txs</th><th>Kind</th></tr></thead>
<tbody>${
    rows
      .map(
        (r) => `<tr><td><a class="mono" href="/address/${esc(r.address)}">${esc(r.address)}</a>${r.impersonates ? `<br><small>can sign for <a href="/address/${esc(r.impersonates)}">${esc(short(r.impersonates, 8))}</a></small>` : ''}</td>
<td>${btc(BigInt(r.balance))}</td><td>${r.txCount}</td><td><span class="chip">${esc(r.kind)}${r.pinned ? '' : ' · live'}</span></td></tr>`,
      )
      .join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No accounts yet.</td></tr>'
  }</tbody></table></div></div></div>`
  return shell(ctx, 'Accounts', body, 'accounts')
}

// --- admin ------------------------------------------------------------------------------

/** JSON literal that is safe inside an inline <script>. */
function jsLiteral(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function adminPage(ctx: PageCtx, admins: string[], impersonators: Record<string, string[]>): string {
  if (admins.length === 0) {
    return shell(ctx, 'Admin', `<div class="wrap"><h1 class="page">Admin<small>Admin tools are disabled: no ADMINS are configured for this deployment.</small></h1></div>`, 'admin')
  }
  const pairs = Object.entries(impersonators).flatMap(([tee, imps]) => imps.map((imp) => ({ imp, tee })))
  const body = `<div class="wrap">
<h1 class="page">Admin<small>Every action is a message signed by one of the configured admin addresses (BIP-322). Connect a wallet to sign in the browser, or sign the shown message elsewhere and paste the signature.</small></h1>
<div class="grid" style="margin-top:20px">
<div>
  <div class="card"><h2>Signer</h2>
    <div class="row" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="connect" type="button">Connect Unisat</button>
      <input id="admin" class="in" style="flex:1 1 220px;width:auto" placeholder="Admin address" autocomplete="off" spellcheck="false">
    </div>
    <p><small>Allowed: ${admins.map((a) => `<span class="mono">${esc(a)}</span>`).join(', ')}</small></p>
    <div id="manual" hidden>
      <p><small>Sign this message with the admin address (BIP-322 simple), then paste the base64 signature.</small></p>
      <pre class="code" id="msg"></pre>
      <div class="row" style="display:flex;gap:10px;margin-top:10px"><input id="sig" class="in" style="flex:1;width:auto" placeholder="Signature (base64)" autocomplete="off"><button class="btn" id="sigok" type="button">Submit</button></div>
    </div>
    <div id="out" role="status" style="margin-top:12px;word-break:break-all"></div>
  </div>
  <div class="card"><h2>Explorer appearance</h2>
    <p><small>Upstream mode shows the explorer as the real chain's: no sandbox wording, faucet or admin links. Currently <b>${ctx.whitelabel ? 'upstream' : 'sandbox'}</b>.</small></p>
    <div class="row" style="display:flex;gap:10px"><button class="btn" data-ui="false" type="button">Sandbox</button><button class="btn" data-ui="true" type="button">Upstream</button></div>
  </div>
  <div class="card"><h2>Clear sandbox</h2>
    <p><small>Removes every sandbox block and transaction and starts the timeline again from the fork point (genesis balances are re-applied).</small></p>
    <button class="btn" id="clear" type="button" style="background:var(--danger);border-color:var(--danger)">Clear sandbox</button>
  </div>
</div>
<div>
  <div class="card"><h2>Account impersonation</h2>
    <p><small>A signature by the <b>impersonator</b> address may spend the <b>impersonatee</b>'s outputs, real or sandbox. The signature commits to the impersonator's script, so it is useless on the real chain.</small></p>
    <div class="scroll"><table class="t"><thead><tr><th>Impersonator</th><th>Impersonatee</th><th></th></tr></thead><tbody>${
      pairs
        .map((p) => `<tr><td class="mono">${esc(p.imp)}</td><td class="mono">${esc(p.tee)}</td><td><button class="btn" style="height:28px;min-width:0;padding:0 10px;font-size:13px" data-rm="${esc(p.imp)}" type="button">Remove</button></td></tr>`)
        .join('') || '<tr><td colspan="3" style="text-align:center;color:var(--muted)">None.</td></tr>'
    }</tbody></table></div>
    <form id="imp" class="faucet" style="margin-top:14px"><div class="row">
      <input id="imp-a" class="in" placeholder="Impersonator address" required autocomplete="off" spellcheck="false">
      <input id="imp-b" class="in" placeholder="Impersonatee address" required autocomplete="off" spellcheck="false">
      <button class="btn" type="submit">Set</button></div></form>
  </div>
</div>
</div></div>
<script>
const ADMINS = ${jsLiteral(admins)}
const $ = (id) => document.getElementById(id)
const out = (t) => { $('out').textContent = t }
async function rpc(method, params) {
  const r = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [params] }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}
$('connect').addEventListener('click', async () => {
  try {
    if (!window.unisat) throw new Error('No Unisat wallet found; paste a signature instead.')
    const [a] = await window.unisat.requestAccounts()
    $('admin').value = a
    $('connect').dataset.ok = '1'
    out('Connected ' + a + (ADMINS.includes(a) ? '' : ' (not an admin on this deployment)'))
  } catch (e) { out(String(e.message || e)) }
})
function manualSign(message) {
  return new Promise((resolve, reject) => {
    $('msg').textContent = message
    $('sig').value = ''
    $('manual').hidden = false
    $('sigok').onclick = () => { const v = $('sig').value.trim(); if (!v) return; $('manual').hidden = true; resolve(v) }
  })
}
async function act(action, fields, method) {
  try {
    const admin = $('admin').value.trim()
    if (!admin) throw new Error('Enter or connect the admin address first.')
    out('Preparing…')
    const { message, deadline } = await rpc('fakereum_adminMessage', { action, ...fields })
    const signature = window.unisat && $('connect').dataset.ok
      ? await window.unisat.signMessage(message, 'bip322-simple')
      : await manualSign(message)
    out('Submitting…')
    const res = await rpc(method, { ...fields, admin, signature, deadline })
    out('Done: ' + JSON.stringify(res))
    setTimeout(() => location.reload(), 800)
  } catch (e) { out(String(e.message || e)) }
}
$('imp').addEventListener('submit', (e) => { e.preventDefault(); act('setImpersonator', { impersonator: $('imp-a').value.trim(), impersonatee: $('imp-b').value.trim() }, 'fakereum_setImpersonator') })
document.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => act('removeImpersonator', { impersonator: b.dataset.rm }, 'fakereum_removeImpersonator')))
document.querySelectorAll('[data-ui]').forEach((b) => b.addEventListener('click', () => act('setUiMode', { upstream: b.dataset.ui === 'true' }, 'fakereum_setUiMode')))
$('clear').addEventListener('click', () => { if (confirm('Remove every sandbox block and transaction?')) act('clearSandbox', {}, 'fakereum_clearSandbox') })
</script>`
  return shell(ctx, 'Admin', body, 'admin')
}
