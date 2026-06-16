// Landing page (GET /). Faithful port of landing.go's landingTmpl.
//
// Go uses html/template, which auto-escapes interpolated values per context:
// HTML element content / attributes use HTML escaping (via esc()), while the
// three values inlined into the inline <script>'s JS string literals
// (chainIdHex / chainName / symbol) need JS-string escaping instead. esc()
// reproduces the HTML-context behavior; jsString() reproduces the JS-context
// behavior so the values can't break out of their quoted literals.

import type { Config } from '../types'
import { esc } from './html'

export interface RenderLandingOpts {
  cfg: Config
  upstreams: string[]
  upstreamName: string
  upstreamId: bigint
  upstreamError?: string
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
      case ' ':
        out += '\\u2028'
        break
      case ' ':
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
  const { cfg, upstreams, upstreamName, upstreamId, upstreamError } = opts

  const chainIdDec = cfg.chainId.toString()
  const chainIdHex = '0x' + cfg.chainId.toString(16)
  const networkName = cfg.networkName
  const symbol = cfg.symbol
  const failoverCount = Math.max(0, upstreams.length - 1)

  const upstream0 = upstreams[0] ?? ''

  const upstreamRpcRows = upstreams
    .map((u, i) => `${i ? '<br>' : ''}<code>${esc(u)}</code>`)
    .join('')

  const upstreamIdSuffix =
    upstreamId !== 0n
      ? ` <span style="color:#7d8590">(${esc(upstreamId.toString())} / 0x${esc(upstreamId.toString(16))})</span>`
      : ''

  const upstreamErrorRow = upstreamError
    ? `<dt>Status</dt><dd class="err">${esc(upstreamError)}</dd>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fakereum sandbox</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1.25rem; background:#0e1116; color:#e6edf3; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  .tag { color:#7d8590; font-size: .85rem; letter-spacing:.05em; text-transform: uppercase; }
  dl { display: grid; grid-template-columns: 8rem 1fr; gap: .35rem .75rem; margin: 1.5rem 0 2rem; }
  dt { color:#7d8590; }
  dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  button { background:#238636; color:#fff; border:0; padding:.7rem 1.1rem; font: inherit; border-radius:6px; cursor:pointer; }
  button:hover { background:#2ea043; }
  button:disabled { background:#30363d; color:#7d8590; cursor:default; }
  .row { display:flex; gap:.75rem; align-items:center; }
  #status { color:#7d8590; font-size:.9rem; }
  .err { color:#f85149; }
  .ok { color:#3fb950; }
  code { background:#161b22; padding:.1em .3em; border-radius:3px; }
  ul.explore { list-style: none; padding: 0; margin: .5rem 0 0; }
  ul.explore li { margin: .3rem 0; }
  ul.explore a { text-decoration: none; color:#58a6ff; }
  ul.explore a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="tag">fakereum sandbox</div>
  <h1>Forked EVM sandbox</h1>
  <p style="color:#7d8590">A signed transaction sent here executes locally; this server's sandbox state is layered atop <code>${esc(upstream0)}</code>${failoverCount ? ` <span class="muted">(+${esc(failoverCount.toString())} failover)</span>` : ''} and never reaches the real chain.</p>

  <dl>
    <dt>Network name</dt>       <dd>${esc(networkName)}</dd>
    <dt>Chain ID</dt>           <dd>${esc(chainIdDec)} <span style="color:#7d8590">(${esc(chainIdHex)})</span></dd>
    <dt>RPC endpoint</dt>       <dd id="rpc">…</dd>
    <dt>API endpoint</dt>       <dd id="api">…</dd>
    <dt>Currency</dt>           <dd>${esc(symbol)}</dd>
  </dl>

  <div class="tag" style="margin-top:2rem">upstream chain</div>
  <dl>
    <dt>Network</dt>            <dd>${esc(upstreamName)}${upstreamIdSuffix}</dd>
    <dt>RPC</dt>                <dd>${upstreamRpcRows}</dd>
    ${upstreamErrorRow}
  </dl>

  <div class="row">
    <button id="add">Add to wallet</button>
    <span id="status"></span>
  </div>

  <div class="tag" style="margin-top:2rem">explore</div>
  <ul class="explore">
    <li><a href="/txs">Sandbox transactions &rarr;</a></li>
    <li><a href="/accounts">Sandbox accounts &rarr;</a></li>
    <li><a href="/admin">Admin &rarr;</a></li>
    <li><a href="https://github.com/Zergity/fakereum" target="_blank" rel="noopener noreferrer">Source on GitHub &nearr;</a></li>
  </ul>

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
</body>
</html>
`
}
