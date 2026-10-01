import { themeCSS } from './theme'

// Shared server-side HTML rendering toolkit for the explorer/admin/landing
// pages. `esc` is the contextual escape used everywhere user/chain data is
// interpolated into markup (replacing Go's html/template auto-escaping).

/** Escape text for safe interpolation into HTML element content / attributes. */
export function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Human label for a contract-deploy mechanism, shown in the explorer. Only two
 * labels: a top-level (zero-`to` tx) deploy and the CREATE opcode are both plain
 * CREATE; CREATE2 is the salted variant.
 */
export function deployLabel(method: 'tx' | 'create' | 'create2' | undefined): string {
  return method === 'create2' ? 'CREATE2' : 'CREATE'
}

/** A `.pill.deploy` badge naming the deploy mechanism (already HTML-safe). */
export function deployPill(method: 'tx' | 'create' | 'create2' | undefined): string {
  return `<span class="badge deploy">${esc(deployLabel(method))}</span>`
}

/** Build a complete HTML Response with the no-store-friendly content type. */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// --------------------------------------------------------------------------
// Page shell shared by every page: top bar, header/nav, hero with search, a
// main container and a footer. Styling lives in ./theme (explorer design
// handoff tokens + components).
// --------------------------------------------------------------------------

export type NavTab = 'home' | 'txs' | 'accounts' | 'import' | 'admin' | ''

export interface ShellOpts {
  title: string
  /** Hero heading (plain text, escaped here). */
  heading: string
  /** Optional mono line under the heading (plain text, escaped here). */
  sub?: string
  networkName: string
  chainId: string
  symbol?: string
  active?: NavTab
  /** Prefix for in-app links; '' when served from the root. */
  baseURL?: string
  /** Full-height hero (landing). Inner pages get the compact band. */
  tallHero?: boolean
  /** Already-escaped markup placed in <main>. For the landing page it starts
   *  with the stats card, which overlaps the hero. */
  body: string
}

const ICON_SUN = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
const ICON_DIM = '<svg class="i" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="M17 3v4M15 5h4M21 9v2M20 10h2"/></svg>'
const ICON_DARK = '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
const ICON_AUTO = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>'
const ICON_MOON = '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
const ICON_GEAR = '<svg class="i" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
const ICON_COIN = '<svg class="i" viewBox="0 0 24 24"><path d="M12 2 5 12l7 4 7-4z"/><path d="m5 13.5 7 8.5 7-8.5-7 4z"/></svg>'
const ICON_GLOBE = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
const ICON_HASH = '<svg class="i" viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/></svg>'
const ICON_CHEV = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'
const ICON_SEARCH = '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>'

// Runs in <head> so the saved theme is applied before first paint.
const THEME_BOOT =
  "try{var p=localStorage.getItem('fakereum-theme')||'auto',t=p;if(p==='auto')t=matchMedia('(prefers-color-scheme: dark)').matches?'dim':'light';var d=document.documentElement;d.dataset.theme=t;d.dataset.themePref=p}catch(e){document.documentElement.dataset.theme='light';document.documentElement.dataset.themePref='auto'}"

export function renderShell(o: ShellOpts): string {
  const b = o.baseURL ?? ''
  const cur = (t: NavTab) => (o.active === t ? ' class="active"' : '')
  const grp = (ts: NavTab[]) => (o.active && ts.includes(o.active) ? ' class="active"' : '')
  const bj = JSON.stringify(b)
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
<script>${THEME_BOOT}</script>
<style>${themeCSS}</style>
</head>
<body>
<div class="topbar">
  <div class="container">
    <div>
      <span class="stat">${ICON_GLOBE}Network: <b>${esc(o.networkName)}</b></span>
      <span class="stat">${ICON_HASH}Chain ID: <b>${esc(o.chainId)}</b></span>${o.symbol ? `\n      <span class="stat">${ICON_COIN}Currency: <b>${esc(o.symbol)}</b></span>` : ''}
    </div>
    <div class="tools">
      <a class="icon-btn" href="${esc(b)}/admin" title="Admin" aria-label="Admin">${ICON_GEAR}</a>
      <div class="theme-dd" id="themeDd">
        <button class="icon-btn" id="themeBtn" type="button" title="Theme" aria-label="Theme" aria-haspopup="true" aria-expanded="false">${ICON_DIM}</button>
        <div class="dropdown" id="themeMenu">
          <button type="button" data-pref="light">${ICON_SUN}<span>Light</span></button>
          <button type="button" data-pref="dim">${ICON_DIM}<span>Dim</span></button>
          <button type="button" data-pref="dark">${ICON_DARK}<span>Dark</span></button>
          <button type="button" data-pref="auto">${ICON_AUTO}<span>Auto (System)</span></button>
        </div>
      </div>
      <a class="icon-btn" href="${esc(b)}/" title="Home" aria-label="Home">${ICON_COIN}</a>
    </div>
  </div>
</div>
<header class="header">
  <div class="container">
    <a class="brand" href="${esc(b)}/"><span class="brand-mark"></span>Fakereum</a>
    <nav class="nav">
      <a href="${esc(b)}/"${cur('home')}>Home</a>
      <div class="dd"><a href="${esc(b)}/txs"${grp(['txs', 'accounts'])}>Blockchain${ICON_CHEV}</a>
        <div class="dropdown"><a href="${esc(b)}/txs">Transactions</a><a href="${esc(b)}/accounts">Accounts</a></div></div>
      <div class="dd"><a href="${esc(b)}/import"${grp(['import', 'admin'])}>Tools${ICON_CHEV}</a>
        <div class="dropdown"><a href="${esc(b)}/import">Import a balance</a><a href="${esc(b)}/admin">Admin</a></div></div>
      <div class="dd"><a href="${esc(b)}/#etherscan-api">API${ICON_CHEV}</a>
        <div class="dropdown"><a href="${esc(b)}/#etherscan-api">Etherscan API</a><a href="${esc(b)}/#discovery">Discovery</a><a href="${esc(b)}/#signed">Signed messages</a></div></div>
    </nav>
  </div>
</header>
<section class="hero${o.tallHero ? '' : ' compact'}">
  <div class="container">
    <h1>${esc(o.heading)}</h1>${o.sub ? `\n    <p class="sub">${esc(o.sub)}</p>` : ''}
    <form class="search" id="q" onsubmit="return fakereumSearch(this)">
      <select name="kind" aria-label="Filter"><option value="all">All Filters</option><option value="address">Addresses</option><option value="tx">Txn Hash</option></select>
      <input name="q" placeholder="Search by Address / Txn Hash" autocomplete="off" spellcheck="false">
      <button class="btn btn-primary" type="submit" aria-label="Search">${ICON_SEARCH}</button>
    </form>
  </div>
</section>
<main class="container ${o.tallHero ? 'landing-main' : 'page-main'}">
${o.body}
</main>
<footer class="footer"><div class="container muted"><span>Fakereum sandbox explorer</span><span>Sandbox state is an overlay on the forked chain and does not exist on the real network.</span></div></footer>
<script>
function fakereumSearch(f){var v=f.q.value.trim(),k=f.kind.value,ok=false;
if((k==='all'||k==='tx')&&/^0x[0-9a-fA-F]{64}$/.test(v)){ok=true;location.href=${bj}+'/tx/'+v}
else if((k==='all'||k==='address')&&/^0x[0-9a-fA-F]{40}$/.test(v)){ok=true;location.href=${bj}+'/address/'+v}
f.classList.toggle('bad',!ok);return false}
(function(){var d=document.documentElement,btn=document.getElementById('themeBtn'),menu=document.getElementById('themeMenu'),mq=matchMedia('(prefers-color-scheme: dark)');
var ic={light:${JSON.stringify(ICON_SUN)},dim:${JSON.stringify(ICON_DIM)},dark:${JSON.stringify(ICON_DARK)},auto:${JSON.stringify(ICON_AUTO)}};
function apply(p){var t=p==='auto'?(mq.matches?'dim':'light'):p;d.dataset.theme=t;d.dataset.themePref=p;btn.innerHTML=ic[p==='auto'?t:p];
menu.querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.dataset.pref===p)})}
var dd=document.getElementById('themeDd');function close(){dd.classList.remove('open');btn.setAttribute('aria-expanded','false')}
btn.addEventListener('click',function(e){e.stopPropagation();var o=dd.classList.toggle('open');btn.setAttribute('aria-expanded',String(o))});
menu.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var p=b.dataset.pref;try{localStorage.setItem('fakereum-theme',p)}catch(x){}apply(p);close()});
document.addEventListener('click',close);document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
mq.addEventListener('change',function(){if(d.dataset.themePref==='auto')apply('auto')});
apply(d.dataset.themePref||'auto');
var t=document.querySelectorAll('.tabs a');if(!t.length)return;
function show(){var h=(location.hash||t[0].getAttribute('href')).slice(1);
document.querySelectorAll('.panel-tab').forEach(function(p){p.hidden=p.id!==h});
t.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+h)})}
addEventListener('hashchange',show);show()})();
</script>
</body>
</html>`
}

// --------------------------------------------------------------------------
// humanizeAgo — formats a unix timestamp (seconds) as a short "Ns/m/h/d ago"
// string relative to `now` (seconds). Returns "" for ts==0 (the Go template
// then renders the em-dash), matching lists.go where TimeRel is empty when the
// block context is unknown. Verbatim bucket boundaries from lists.go.
// --------------------------------------------------------------------------
export function humanizeAgo(ts: number, now: number): string {
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
export function formatAbsUTC(ts: number): string {
  const dt = new Date(ts * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ` +
    `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())} UTC`
  )
}

