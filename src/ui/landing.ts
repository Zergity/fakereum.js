// Landing page (GET /). Faithful port of landing.go's landingTmpl.
//
// Go uses html/template, which auto-escapes interpolated values per context:
// HTML element content / attributes use HTML escaping (via esc()), while the
// three values inlined into the inline <script>'s JS string literals
// (chainIdHex / chainName / symbol) need JS-string escaping instead. esc()
// reproduces the HTML-context behavior; jsString() reproduces the JS-context
// behavior so the values can't break out of their quoted literals.

import type { Config, OverlayAccount, StoredTx } from '../types'
import { checksumAddress, strip0x, toBigInt, type Hex } from '../lib/hex'
import { esc, humanizeAgo, identity, renderShell } from './html'
import { INFOS_SENTINEL } from '../infos'
import { importSources } from '../import_balance'

export interface RenderLandingOpts {
  cfg: Config
  upstreams: string[]
  upstreamName: string
  upstreamId: bigint
  upstreamError?: string
  /** Effective replay-guard verdict (see rejectUpstreamSignersEnabled). */
  replayGuard: boolean
  /** Sandbox transactions, any order. */
  txs: StoredTx[]
  /** Overlay accounts, any order. */
  accounts: Array<{ address: Hex; acct: OverlayAccount }>
}

/** Encode a string as the contents of a double-quoted JS string literal. */
function jsString(s: string): string {
  let out = ''
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\'
        break
      case '"':
        out += '\\"'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\u2028':
        out += '\\u2028'
        break
      case '\u2029':
        out += '\\u2029'
        break
      // Defensively escape characters that could prematurely close the
      // surrounding <script> element or start an HTML comment.
      case '<':
        out += '\\u003c'
        break
      case '>':
        out += '\\u003e'
        break
      case '&':
        out += '\\u0026'
        break
      default:
        out += ch
    }
  }
  return out
}

export function renderLanding(opts: RenderLandingOpts): string {
  const { cfg, upstreams, upstreamName, upstreamId, upstreamError, replayGuard, txs, accounts } = opts

  const id = identity(cfg)
  const wl = id.whitelabel
  const chainIdDec = id.chainId
  const chainIdHex = '0x' + BigInt(id.chainId).toString(16)
  const networkName = id.networkName
  const symbol = id.symbol
  const failoverCount = Math.max(0, upstreams.length - 1)

  const upstream0 = upstreams[0] ?? ''

  const upstreamRpcRows = upstreams
    .map((u, i) => `${i ? '<br>' : ''}<code>${esc(u)}</code>`)
    .join('')

  const upstreamIdSuffix =
    upstreamId !== 0n
      ? ` <span class="muted">(${esc(upstreamId.toString())} / 0x${esc(upstreamId.toString(16))})</span>`
      : ''

  const upstreamErrorRow = upstreamError
    ? `<dl class="kv"><dt>Status:</dt><dd class="err">${esc(upstreamError)}</dd></dl>`
    : ''

  // Only rendered when anti-replay protection is active (REJECT_UPSTREAM_SIGNERS
  // true, or auto with sandbox id == upstream id). Mirrors the executor guard.
  const replayGuardSection = replayGuard
    ? `
  <div class="card">
    <div class="card-header"><h2>Replay guard</h2></div>
    <div class="card-body"><p class="dim">Anti-replay protection is <span class="ok">on</span>. A transaction whose signer already holds a native balance on <code>${esc(upstreamName)}</code> is refused — this sandbox shares that chain's ID, so such a signed tx could be replayed onto the real chain. Such an account sends <a href="#signed">signed messages</a> instead; a wallet that is empty upstream transacts directly.</p></div>
  </div>`
    : ''

  const iGlobe = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
  const iCoin = '<svg class="i" viewBox="0 0 24 24"><path d="M12 2 5 12l7 4 7-4z"/><path d="m5 13.5 7 8.5 7-8.5-7 4z"/></svg>'
  const iStack = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>'
  const iGauge = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  const iCube = '<svg class="i" viewBox="0 0 24 24"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></svg>'
  const iDoc = '<svg class="i" viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M9 12h7M9 16h7M9 8h3"/></svg>'
  const iUser = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'
  const iDown = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>'
  const iKey = '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/></svg>'
  const iGit = '<svg class="i" viewBox="0 0 24 24"><path d="M9 19c-4 1-4-2-6-2m12 4v-3.5a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.1-3.3s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.5 4.5 0 0 0-.1 3.3A4.8 4.8 0 0 0 4 9.7c0 4.8 3 5.9 5.8 6.2a3 3 0 0 0-.8 2.3V21"/></svg>'
  const item = (icon: string, label: string, value: string) =>
    `<div class="stat-item">${icon}<div><div class="cap">${label}</div><div>${value}</div></div></div>`
  const pair = (icon: string, l1: string, v1: string, l2: string, v2: string) =>
    `<div class="stat-item" style="justify-content:space-between">${icon}<div style="flex:1"><div class="cap">${l1}</div><div>${v1}</div></div><div style="text-align:right"><div class="cap">${l2}</div><div>${v2}</div></div></div>`

  const now = Math.floor(Date.now() / 1000)
  const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)
  const newestTxs = [...txs].sort((x, y) => y.seq - x.seq)
  const latestTxs = newestTxs.slice(0, 6)
  const latestAccounts = [...accounts]
    .sort((x, y) => (y.acct.nonce != null ? Number(toBigInt(y.acct.nonce)) : 0) - (x.acct.nonce != null ? Number(toBigInt(x.acct.nonce)) : 0))
    .slice(0, 6)

  // Gas used by the last 14 sandbox txs, oldest first.
  const series = newestTxs.slice(0, 14).reverse().map((t) => Number(toBigInt(t.gasUsed)))
  const kfmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
  let chart = '<div class="muted" style="margin-top:12px">Needs at least two transactions.</div>'
  if (series.length >= 2) {
    const hi = Math.max(...series), lo = Math.min(...series), span = hi - lo || 1
    const pts = series.map((v, i) => `${((i / (series.length - 1)) * 300).toFixed(1)},${(52 - ((v - lo) / span) * 48).toFixed(1)}`).join(' ')
    chart = `<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-top:8px;align-items:center">
        <div class="muted" style="display:flex;flex-direction:column;justify-content:space-between;height:56px"><span>${esc(kfmt(hi))}</span><span>${esc(kfmt(lo))}</span></div>
        <svg viewBox="0 0 300 56" preserveAspectRatio="none" style="width:100%;height:56px"><polyline fill="none" stroke="var(--c-text-muted)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
        <span></span><div class="muted" style="display:flex;justify-content:space-between"><span>oldest</span><span>newest</span></div>
      </div>`
  }

  const statsCard = `  <div class="card stats">
    <div>
      ${item(iGlobe, 'Network name', esc(networkName))}
      ${wl ? item(iGauge, 'Chain ID', `${esc(chainIdDec)} <span class="muted">(${esc(chainIdHex)})</span>`) : item(iCoin, 'Upstream chain', `${esc(upstreamName)}${upstreamIdSuffix}`)}
    </div>
    <div>
      ${pair(iStack, wl ? 'Transactions' : 'Sandbox transactions', esc(txs.length.toLocaleString('en-US')), wl ? 'Accounts' : 'Sandbox accounts', esc(accounts.length.toLocaleString('en-US')))}
      ${wl ? item(iCoin, 'Currency', esc(symbol)) : pair(iGauge, 'Chain ID', `${esc(chainIdDec)} <span class="muted">(${esc(chainIdHex)})</span>`, 'Currency', esc(symbol))}
    </div>
    <div>
      <div class="cap">Gas used, last ${series.length || 14} ${wl ? '' : 'sandbox '}txs</div>
      ${chart}
    </div>
  </div>
`

  const pill = (t: string) => `<span class="badge">${esc(t)}</span>`
  const txRows = latestTxs
    .map((t) => {
      const from = checksumAddress(t.from)
      const toAddr = t.contractAddress ?? t.to
      const to = toAddr ? checksumAddress(toAddr) : ''
      const bt = Number(toBigInt(t.blockTime))
      const age = bt ? humanizeAgo(bt, now) : ''
      return `<div class="list-row"><div class="icon-tile">${iDoc}</div>
          <div class="t"><a class="truncate" href="/tx/${esc(t.hash)}">${esc(t.hash.slice(0, 14))}…</a><div class="muted">${esc(age || (t.status === 1 ? 'Success' : 'Reverted'))}</div></div>
          <div>From <a href="/address/${esc(from)}">${esc(short(from))}</a><div>To ${to ? `<a href="/address/${esc(to)}">${esc(short(to))}</a>` : '<span class="muted">—</span>'}</div></div>
          ${t.status === 1 ? pill(toBigInt(t.gasUsed).toString() + ' gas') : '<span class="badge badge-danger">Reverted</span>'}</div>`
    })
    .join('\n        ')
  const acctRows = latestAccounts
    .map(({ address, acct }) => {
      const a = checksumAddress(address)
      const isContract = acct.code != null && strip0x(acct.code as string).length > 0
      const slots = acct.storage ? Object.keys(acct.storage).length : 0
      return `<div class="list-row"><div class="icon-tile">${isContract ? iCube : iUser}</div>
          <div class="t"><a class="truncate" href="/address/${esc(a)}">${esc(short(a))}</a><div class="muted">${isContract ? 'Contract' : 'EOA'}</div></div>
          <div>Nonce ${acct.nonce != null ? esc(toBigInt(acct.nonce).toString()) : '<span class="muted">—</span>'}<div class="muted">${acct.selfDestructed ? 'self-destructed' : wl ? '&nbsp;' : 'sandbox overlay'}</div></div>
          ${pill(slots + (slots === 1 ? ' slot' : ' slots'))}</div>`
    })
    .join('\n        ')
  const emptyRow = (t: string) => `<div class="empty">${t}</div>`
  const latest = `  <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--grid-gutter)">
    <div class="card">
      <div class="card-header"><h2>Latest Transactions</h2><a class="btn btn-white btn-sm" href="/txs">View all</a></div>
      <div class="card-body">
        ${txRows || emptyRow(wl ? 'No transactions yet.' : 'No sandbox transactions yet.')}
      </div>
      <div class="card-footer"><a href="/txs">View all transactions →</a></div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Latest Accounts</h2><a class="btn btn-white btn-sm" href="/accounts">View all</a></div>
      <div class="card-body">
        ${acctRows || emptyRow(wl ? 'No accounts yet.' : 'No sandbox accounts yet.')}
      </div>
      <div class="card-footer"><a href="/accounts">View all accounts →</a></div>
    </div>
  </div>
`

  if (wl) {
    return renderShell({
      title: `${networkName} Explorer`,
      heading: `${networkName} Explorer`,
      ...id,
      active: 'home',
      whitelabel: true,
      tallHero: true,
      body: `${statsCard}\n${latest}`,
    })
  }

  const exploreRow = (icon: string, href: string, title: string, desc: string, ext = false) =>
    `<div class="list-row" style="grid-template-columns:48px 1fr"><div class="icon-tile">${icon}</div><div class="t"><a class="title" href="${href}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${title}</a><div class="muted">${desc}</div></div></div>`

  const body = `${statsCard}
${latest}
  <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--grid-gutter)">
    <div class="card">
      <div class="card-header"><h2>Sandbox</h2></div>
      <div class="card-body">
        <p class="dim">A signed transaction sent here executes locally; this server's sandbox state is layered atop <code>${esc(upstream0)}</code>${failoverCount ? ` <span class="muted">(+${esc(failoverCount.toString())} failover)</span>` : ''} and never reaches the real chain.</p>
        <div class="row">
          <button class="btn btn-primary" id="add" type="button">Add to wallet</button>
          <span id="status" class="status"></span>
        </div>
        <dl class="kv" style="margin-top:16px"><dt>RPC endpoint:</dt><dd class="mono" id="rpc">…</dd></dl>
        <dl class="kv"><dt>Etherscan API:</dt><dd class="mono" id="api">…</dd></dl>
        <dl class="kv"><dt>Upstream RPC:</dt><dd>${upstreamRpcRows}</dd></dl>
        ${upstreamErrorRow}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Explore</h2></div>
      <div class="card-body">
        ${exploreRow(iDoc, '/txs', 'Sandbox transactions', 'Every tx executed in the sandbox, newest first')}
        ${exploreRow(iUser, '/accounts', 'Sandbox accounts', 'Addresses whose state the sandbox overrides')}
        ${exploreRow(iDown, '/import', 'Import a balance', 'Bring a balance over from another chain')}
        ${exploreRow(iKey, '/admin', 'Admin', 'Impersonation, bytecode replacement, clearing')}
        ${exploreRow(iGit, 'https://github.com/Zergity/fakereum', 'Source on GitHub', 'Fakereum repository', true)}
      </div>
    </div>
  </div>
${replayGuardSection}
  <div class="card" id="etherscan-api">
    <div class="card-header"><h2>Etherscan API</h2></div>
    <div class="card-body">
  <p class="dim">The <code>/api</code> and <code>/v2/api</code> endpoints are an Etherscan <strong>v2</strong>-compatible proxy. ${
    cfg.etherscanStyle === 'blockscout'
      ? 'No API key is needed — the upstream explorer is a Blockscout instance.'
      : 'Pass your own Etherscan API key (<code>apikey=…</code>) — it is required and forwarded upstream as-is.'
  } Requests go to <code>${esc(upstreamName)}</code>'s explorer with <code>chainid</code> forced. Currently only the <code>logs&amp;action=getLogs</code> module is supported; its response is merged with this sandbox's logs so your tooling sees local state alongside the real chain. Both paths are also returned by discovery below (<code>etherscanApi</code> / <code>etherscanApiV2</code>).</p>
    </div>
  </div>

  <div class="card" id="discovery">
    <div class="card-header"><h2>Discovery</h2></div>
    <div class="card-body">
  <p class="dim">Detect this sandbox from a dapp without any custom RPC method. Wallets refuse to forward <code>fakereum_*</code> calls but always relay <code>eth_call</code>, so a call to the sentinel below (calldata ignored — no real chain has code there) returns the sandbox config, ABI-encoded as a single <code>string</code> of JSON:</p>
  <pre><code>eth_call({ to: "${esc(INFOS_SENTINEL)}" })
↳ abi-decode the result to a string, then JSON.parse:

{
  "chainId":          "0x…",      // this sandbox
  "upstreamChainId":  "0x…",      // forked chain
  "networkName":      "…",
  "upstreamChainName": "…",      // e.g. "Arbitrum One" — header of every signed message
  "symbol":           "…",
  "rpc":              "…/rpc",     // JSON-RPC
  "etherscanApi":     "…/api",     // Etherscan v2 proxy
  "etherscanApiV2":   "…/v2/api",  // same proxy, /v2/api path
  "explorer":         "…",         // this explorer
  "upstreamRpc":      "…",         // real chain's RPC — check an account's upstream balance here
  "upstreamExplorer": { "name": "…", "url": "…" }   // optional
}</code></pre>

    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Balances</h2></div>
    <div class="card-body">
  <p class="dim">Every account starts out holding <strong>${esc(cfg.balanceMultiplier.toString())}×</strong> its native balance on ${esc(upstreamName)}, automatically — <code>eth_getBalance</code> and transactions here see that figure until the account's first sandbox transaction lands, after which the sandbox tracks the balance itself. Funds on another chain (${esc(importSources(cfg).map((c) => c.name).join(', '))}) can be <a href="/import">imported once per account</a> at the same multiplier, authorized by a <code>personal_sign</code> message.</p>
    </div>
  </div>

  <div class="card" id="signed">
    <div class="card-header"><h2>Send with a signed message</h2></div>
    <div class="card-body">
  <p class="dim">Besides <code>eth_sendRawTransaction</code>, a transaction can be submitted as a plain <code>personal_sign</code> (EIP-191) message. The signature is chain-agnostic, so the wallet can sit on any network — no sandbox chain added, no switch. The message binds nonce, recipient, value and calldata; gas limit and fee terms are passed unsigned alongside (defaulted wallet-style when omitted). The sandbox then runs a normal transaction from the signer. Ask for the text (pass <code>from</code> and the sandbox reads the nonce for you), have the wallet sign it, post fields + signature straight to <code>/rpc</code>:</p>
  <pre><code>fakereum_transactionMessage [{ from?, to?, value?, data?, nonce? }]  → { message, nonce }
fakereum_sendTransaction    [{ to?, value?, data?, nonce, gas?, gasPrice? | maxFeePerGas?, maxPriorityFeePerGas?, signature }]
                            → tx hash

Fakereum Tx #13 on ${esc(upstreamName)}
To: 0x…                                   (EIP-55 checksummed; "To: CREATE" for a deploy)
Value: 0.001                              (only if &gt; 0; native units, up to 18 decimals)
Data: 0x12345678 and 68 bytes with hash 0x…   (only if data non-empty; tail only past 4 bytes)</code></pre>
  <p class="dim">Fields are named and hex-encoded as in <code>eth_sendTransaction</code>. The same signed message is accepted once — a resend answers <code>already known</code>.</p>
  <p class="dim">Which path an account should take is the sandbox's call: <code>fakereum_accountKind [address]</code> answers <code>{ kind: "upstream" | "sandbox", pinned }</code> — <code>upstream</code> (holds native token on the real chain) must send signed messages and must not be asked for EIP-712 signatures; <code>sandbox</code> uses the normal wallet flows. The verdict is pinned for good by the account's first sandbox transaction; reads before that follow the live upstream balance.</p>

    </div>
  </div>

  <script>
    const chainIdHex = "${jsString(chainIdHex)}";
    const chainName  = "${jsString(networkName)}";
    const symbol     = "${jsString(symbol)}";
    const rpcUrl = window.location.origin + "/rpc";
    const apiUrl = window.location.origin + "/api";
    document.getElementById("rpc").textContent = rpcUrl;
    document.getElementById("api").textContent = apiUrl;

    const btn = document.getElementById("add");
    const status = document.getElementById("status");

    btn.addEventListener("click", async () => {
      if (!window.ethereum) {
        status.textContent = "no injected wallet detected";
        status.className = "err";
        return;
      }
      status.textContent = "requesting…";
      status.className = "";
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainIdHex,
            chainName: chainName,
            rpcUrls: [rpcUrl],
            nativeCurrency: { name: chainName, symbol: symbol, decimals: 18 },
            blockExplorerUrls: [apiUrl],
          }],
        });
        status.textContent = "added — switch your wallet to it";
        status.className = "ok";
      } catch (e) {
        status.textContent = e.message || String(e);
        status.className = "err";
      }
    });
  </script>
`

  return renderShell({
    title: 'Fakereum sandbox',
    heading: 'Forked EVM sandbox',
    ...id,
    active: 'home',
    tallHero: true,
    body,
  })
}
