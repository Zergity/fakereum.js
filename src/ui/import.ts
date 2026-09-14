// Import page (GET /import). Client-side: connect an injected wallet, list the
// account's native balance on every supported source chain (fakereum_importSources),
// pick one, personal_sign the import message (fakereum_importMessage) and
// submit it (fakereum_importBalance). One import per account; the page shows
// the record afterwards. Every interpolated server value goes through esc().

import type { Config } from '../types'
import { esc, explorerCSS } from './html'
import { chainName } from '../lib/chains'

export interface RenderImportPageOptions {
  cfg: Config
  /** Supported source chains for this sandbox (upstream excluded), for the static list. */
  sources: Array<{ chainId: bigint; name: string; symbol: string }>
}

const jsString = (s: string): string => JSON.stringify(s).slice(1, -1)

export function renderImportPage(opts: RenderImportPageOptions): string {
  const { cfg, sources } = opts
  const multiplier = cfg.balanceMultiplier.toString()
  const upstreamName = chainName(cfg.upstreamChainId)
  const sourceNames = sources.map((s) => esc(s.name)).join(', ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Import balance · Fakereum</title>
<style>
${explorerCSS}
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1.25rem; background:#0e1116; color:#e6edf3; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.05rem; color:#e6edf3; }
  .tag { color:#7d8590; font-size: .85rem; letter-spacing:.05em; text-transform: uppercase; }
  a { color:#58a6ff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color:#7d8590; }
  .panel { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:1rem 1.1rem; }
  table { width:100%; border-collapse: collapse; }
  th, td { padding: .55rem .5rem; border-bottom:1px solid #21262d; vertical-align: middle; }
  th { text-align:left; color:#7d8590; font-weight:500; font-size:.85rem; text-transform:uppercase; letter-spacing:.04em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.92rem; }
  tr:last-child td { border-bottom: 0; }
  tr.pick { cursor: pointer; }
  tr.pick:hover td { background:#1c2128; }
  tr.selected td { background:#1f2a1f; }
  button { background:#238636; color:#fff; border:0; padding:.5rem .9rem; font: inherit; border-radius:6px; cursor:pointer; }
  button:hover { background:#2ea043; }
  button:disabled { background:#30363d; color:#7d8590; cursor:default; }
  .row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
  #status { color:#7d8590; font-size:.9rem; }
  .err { color:#f85149; }
  .ok { color:#3fb950; }
  .pill { display:inline-block; padding:.05rem .45rem; border-radius:999px; font-size:.75rem; border:1px solid #30363d; color:#7d8590; margin-left:.4rem; }
  .pill.done { border-color:#238636; color:#3fb950; }
  pre { background:#0e1116; border:1px solid #30363d; padding:.75rem 1rem; border-radius:6px; overflow-x:auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin:.5rem 0 0; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="tag"><a href="/">fakereum sandbox</a> · ${esc(cfg.networkName)}</div>
  <h1>Import a balance from another chain</h1>
  <p class="muted">Every account on this sandbox starts with <strong>${esc(multiplier)}×</strong> its native balance on ${esc(upstreamName)} — that part is automatic. If your funds sit on another chain, import them here: the sandbox reads your balance there and credits <strong>${esc(multiplier)}×</strong> that amount in ${esc(cfg.symbol)}. <strong>One import per account</strong>, from one source chain, ever — choose the chain with the balance you want. Sources: ${sourceNames}.</p>
  <p class="muted">The import is authorized by a <code>personal_sign</code> message; your wallet can be on any network to sign it, and the signature is not a transaction on any chain.</p>

  <div class="row" style="margin:1.25rem 0">
    <button id="connect">Connect wallet</button>
    <span id="wallet" class="mono muted">not connected</span>
    <span id="status"></span>
  </div>

  <div id="content" hidden>
    <div id="donePanel" class="panel" hidden>
      <div class="tag">imported <span class="pill done">done</span></div>
      <p id="doneText" style="margin:.5rem 0 0"></p>
    </div>

    <div id="pickPanel" hidden>
      <h2>Your balances on the source chains</h2>
      <div class="panel">
        <table>
          <thead><tr><th></th><th>Chain</th><th>Balance there</th><th>You would get here</th></tr></thead>
          <tbody id="rows"><tr><td colspan="4" class="muted">loading…</td></tr></tbody>
        </table>
      </div>
      <div class="row" style="margin-top:1rem">
        <button id="import" disabled>Import selected</button>
        <span class="muted" id="hint">select a chain with a non-zero balance</span>
      </div>
      <div id="msgWrap" hidden>
        <div class="tag" style="margin-top:1rem">message to sign</div>
        <pre id="msg"></pre>
      </div>
    </div>
  </div>

  <script>
    const rpcUrl = window.location.origin + "/rpc";
    const symbol = "${jsString(cfg.symbol)}";
    const $ = (id) => document.getElementById(id);
    const status = $("status");
    let account = null, sources = [], selected = null, message = null;

    function setStatus(text, cls) { status.textContent = text || ""; status.className = cls || ""; }

    async function rpc(method, params) {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({jsonrpc:"2.0", id:1, method, params}),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    }

    // wei (0x-hex) -> decimal with up to 6 fractional digits, trailing zeros dropped
    function fmt(hex) {
      const wei = BigInt(hex);
      const whole = wei / 10n**18n;
      const frac = (wei % 10n**18n) / 10n**12n;
      const f = frac.toString().padStart(6, "0").replace(/0+$/, "");
      return whole.toString() + (f ? "." + f : "");
    }

    function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

    async function connect() {
      if (!window.ethereum) { setStatus("no injected wallet detected", "err"); return; }
      try {
        const accts = await window.ethereum.request({method: "eth_requestAccounts"});
        setAccount(accts[0] || null);
      } catch (e) { setStatus(e.message || String(e), "err"); }
    }

    function setAccount(a) {
      account = a;
      $("wallet").textContent = a || "not connected";
      $("wallet").classList.toggle("muted", !a);
      $("content").hidden = !a;
      if (a) load();
    }

    async function load() {
      selected = null; message = null;
      $("import").disabled = true; $("msgWrap").hidden = true;
      setStatus("reading balances…");
      try {
        const r = await rpc("fakereum_importSources", [account]);
        sources = r.sources;
        if (r.imported) {
          $("pickPanel").hidden = true; $("donePanel").hidden = false;
          const src = sources.find((s) => BigInt(s.chainId) === BigInt(r.imported.chainId));
          $("doneText").innerHTML = "This account imported <strong>" + esc(fmt(r.imported.balance)) + "</strong> from "
            + esc(src ? src.name : ("chain " + BigInt(r.imported.chainId))) + " on " + esc(new Date(r.imported.at).toISOString().slice(0,19).replace("T"," ")) + " UTC"
            + " and was credited <strong>" + esc(fmt(r.imported.credit)) + " " + esc(symbol) + "</strong>. An account can import once.";
          setStatus("");
          return;
        }
        $("donePanel").hidden = true; $("pickPanel").hidden = false;
        $("rows").innerHTML = sources.map((s, i) => {
          const ok = !s.error && BigInt(s.balance) > 0n;
          const bal = s.error ? '<span class="err">' + esc(s.error) + "</span>" : esc(fmt(s.balance)) + " " + esc(s.symbol);
          const credit = s.error ? "—" : esc(fmt(s.credit)) + " " + esc(symbol);
          return '<tr class="' + (ok ? "pick" : "muted") + '" data-i="' + i + '"><td>' + (ok ? '<input type="radio" name="src">' : "") + "</td><td>" + esc(s.name)
            + ' <span class="muted">(' + BigInt(s.chainId) + ")</span></td><td class=\\"mono\\">" + bal + '</td><td class="mono">' + credit + "</td></tr>";
        }).join("");
        for (const tr of $("rows").querySelectorAll("tr.pick")) {
          tr.addEventListener("click", () => select(Number(tr.dataset.i)));
        }
        setStatus("");
      } catch (e) { setStatus(e.message || String(e), "err"); }
    }

    async function select(i) {
      selected = sources[i];
      for (const tr of $("rows").querySelectorAll("tr")) {
        const on = Number(tr.dataset.i) === i;
        tr.classList.toggle("selected", on);
        const radio = tr.querySelector("input"); if (radio) radio.checked = on;
      }
      $("hint").textContent = "credits " + fmt(selected.credit) + " " + symbol + " to " + account;
      try {
        const r = await rpc("fakereum_importMessage", [{ account, chainId: selected.chainId }]);
        message = r.message;
        $("msg").textContent = message; $("msgWrap").hidden = false;
        $("import").disabled = false;
      } catch (e) { setStatus(e.message || String(e), "err"); }
    }

    async function doImport() {
      if (!selected || !message) return;
      $("import").disabled = true;
      setStatus("waiting for signature…");
      try {
        const signature = await window.ethereum.request({ method: "personal_sign", params: [message, account] });
        setStatus("importing…");
        const r = await rpc("fakereum_importBalance", [{ account, chainId: selected.chainId, signature }]);
        setStatus("credited " + fmt(r.credit) + " " + symbol + " — new balance " + fmt(r.newBalance) + " " + symbol, "ok");
        await load();
      } catch (e) {
        setStatus(e.message || String(e), "err");
        $("import").disabled = false;
      }
    }

    $("connect").addEventListener("click", connect);
    $("import").addEventListener("click", doImport);
    if (window.ethereum) {
      window.ethereum.request({method: "eth_accounts"}).then((a) => { if (a && a[0]) setAccount(a[0]); }).catch(() => {});
      if (typeof window.ethereum.on === "function") {
        window.ethereum.on("accountsChanged", (a) => setAccount((a && a[0]) || null));
      }
    }
  </script>
</body>
</html>
`
}
