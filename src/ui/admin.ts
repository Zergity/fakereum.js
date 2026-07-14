// Admin page (GET /admin) — faithful port of admin_ui.go.
//
// A mostly client-side app: connect an injected wallet and, for each admin
// tool, sign an EIP-712 typed message then POST a fakereum_* JSON-RPC to /rpc.
// Tools: account-impersonation management (set/remove via
// fakereum_setImpersonator / fakereum_removeImpersonator, listed via
// fakereum_listImpersonators) and the "Clear sandbox" panel
// (fakereum_clearSandbox) with include/exclude boxes persisted in localStorage
// per chain id.
//
// The EIP-712 domain matches the Go server byte-for-byte:
//   { name: "fakereum-impersonate", version: "1", chainId: <cfg.chainId> }
// The clearSandbox tool SHARES this domain; its primaryType is
//   ClearSandbox(address[] include,address[] exclude)
// The set/remove types replicate impersonate_rpc.go's canonical encodeType:
//   SetImpersonator(address impersonator,address impersonatee)
//   RemoveImpersonator(address impersonator)

import type { Config, ReqContext } from '../types'
import { esc, explorerCSS } from './html'

export interface RenderAdminPageOptions {
  cfg: Config
  ctx: ReqContext
  hasAdmins: boolean
}

/**
 * Render the /admin HTML page.
 *
 * `hasAdmins` mirrors Go's `Enabled` (len(cfg.Admins) > 0): when false the
 * tools are replaced by a notice that impersonation/clear RPCs are disabled.
 * `cfg.admins` is emitted to the client as a JS array of lowercased addresses
 * used to gate the tools to the connected wallet.
 */
export function renderAdminPage(opts: RenderAdminPageOptions): string {
  const { cfg, hasAdmins } = opts

  const chainIdDec = cfg.chainId.toString(10)
  const chainIdHex = '0x' + cfg.chainId.toString(16)
  const networkName = cfg.networkName

  // Lowercased admin addresses for the client-side membership check. esc() is
  // applied because each becomes a quoted JS string literal interpolated into
  // the <script> body.
  const adminsLower = cfg.admins.map((a) => a.toLowerCase())
  const adminSetLiteral = adminsLower.map((a) => `"${esc(a)}"`).join(',')

  const enabledJs = hasAdmins ? 'true' : 'false'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin · Fakereum</title>
<style>
${explorerCSS}
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1.25rem; background:#0e1116; color:#e6edf3; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.05rem; color:#e6edf3; }
  h3 { margin: 1.5rem 0 .5rem; font-size: .95rem; color:#e6edf3; }
  .tag { color:#7d8590; font-size: .85rem; letter-spacing:.05em; text-transform: uppercase; }
  a { color:#58a6ff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color:#7d8590; }
  .panel { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:1rem 1.1rem; }
  table { width:100%; border-collapse: collapse; }
  th, td { padding: .55rem .5rem; border-bottom:1px solid #21262d; vertical-align: middle; }
  th { text-align:left; color:#7d8590; font-weight:500; font-size:.85rem; text-transform:uppercase; letter-spacing:.04em; }
  td.mono, th.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.92rem; word-break: break-all; }
  tr:last-child td { border-bottom: 0; }
  button { background:#238636; color:#fff; border:0; padding:.5rem .9rem; font: inherit; border-radius:6px; cursor:pointer; }
  button:hover { background:#2ea043; }
  button.ghost { background:#21262d; color:#e6edf3; }
  button.ghost:hover { background:#30363d; }
  button.danger { background:#21262d; color:#f85149; padding:.35rem .7rem; font-size:.85rem; }
  button.danger:hover { background:#30363d; }
  button:disabled { background:#30363d; color:#7d8590; cursor:default; }
  input[type=text], textarea { background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:.55rem .7rem; font: inherit; width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; box-sizing: border-box; }
  input[type=text]:focus, textarea:focus { outline:none; border-color:#58a6ff; }
  textarea { min-height: 4.5rem; resize: vertical; font-size:.92rem; }
  .clear-grid { display:grid; grid-template-columns: 1fr 1fr; gap:.75rem; }
  @media (max-width:560px) { .clear-grid { grid-template-columns: 1fr; } }
  .field-label { color:#7d8590; font-size:.85rem; display:block; margin:0 0 .3rem; }
  .form-row { display:grid; grid-template-columns: 8rem 1fr; gap:.5rem .75rem; align-items:center; margin: .5rem 0; }
  .form-row label { color:#7d8590; }
  .actions { display:flex; gap:.5rem; align-items:center; margin-top:.75rem; }
  .nav { display:flex; flex-wrap:wrap; gap:1rem; margin:0 0 1.25rem; font-size:.92rem; }
  .status { font-size:.9rem; }
  .status.err { color:#f85149; }
  .status.ok  { color:#3fb950; }
  button.warn { background:#9e2f2f; }
  button.warn:hover { background:#b83b3b; }
  .pill { display:inline-block; background:#21262d; padding:.1em .55em; border-radius:999px; font-size:.78rem; color:#7d8590; }
  .pill.admin { background:#1f6feb33; color:#79c0ff; }
  .pill.bad   { background:#f8514922; color:#f85149; }
  .pill.ok    { background:#3fb95022; color:#3fb950; }
  .empty { color:#7d8590; padding:.5rem 0; }
  .arrow { color:#7d8590; padding: 0 .35rem; }
  hr { border:0; border-top:1px solid #21262d; margin: 2rem 0; }
</style>
</head>
<body>
  <nav class="nav">
    <a href="/">&larr; sandbox home</a>
    <a href="/logs">logs</a>
  </nav>
  <div class="tag">${esc(networkName)}</div>
  <h1>Admin</h1>
  <p class="muted" style="margin:.25rem 0 1.25rem">
    Sandbox-admin tools. Every action is authorized by an EIP-712 signature from a configured admin wallet — connect one below to unlock them.
  </p>

${hasAdmins
    ? `  <div class="panel">
    <div class="actions">
      <button id="connect">Connect wallet</button>
      <span id="wallet" class="mono muted">not connected</span>
      <span id="adminBadge"></span>
    </div>
    <div id="authMsg" class="muted" style="margin-top:.6rem; display:none"></div>
  </div>

  <div id="adminContent" hidden>
    <h2>Account impersonation</h2>
    <p class="muted" style="margin:.25rem 0 1.25rem">
      A configured <strong>impersonator</strong> key can submit raw transactions that this sandbox executes as its <strong>impersonatee</strong>: <code>msg.sender</code>, gas payer, nonce, and the <code>ecrecover</code> precompile all see the impersonatee. The address that physically signed is recorded on the receipt as <code>signedBy</code> for transparency. Multiple impersonator keys can share a single impersonatee; re-setting an impersonator simply overwrites its target. Map changes only affect future txs — past receipts keep the resolution they had at apply time.
    </p>

    <h3>Current mappings</h3>
    <div class="panel" id="mappingsPanel">
      <table id="mappings">
        <thead><tr><th>impersonator</th><th></th><th>impersonatee</th><th></th></tr></thead>
        <tbody><tr><td colspan="4" class="empty">loading…</td></tr></tbody>
      </table>
    </div>

    <h3>Add mapping</h3>
    <div class="panel">
      <div class="form-row">
        <label for="newSigner">impersonator</label>
        <input id="newSigner" type="text" placeholder="0x… (the key that submits & signs)">
      </div>
      <div class="form-row">
        <label for="newIdentity">impersonatee</label>
        <input id="newIdentity" type="text" placeholder="0x… (the identity the EVM will see)">
      </div>
      <div class="actions">
        <button id="add">Sign & add</button>
        <span id="status" class="status"></span>
      </div>
    </div>

    <h2>Replace bytecode</h2>
    <p class="muted" style="margin:.25rem 0 1rem">
      Overrides the code at an address with bytecode you supply. Works on any contract — a real one from the upstream chain (the override shadows its on-chain code) or one deployed inside the sandbox. Balance, nonce, and storage are left as-is, so patch a contract in place while keeping its state. Paste <strong>runtime</strong> bytecode (deployed code), not constructor/init code. Leave the box empty (or <code>0x</code>) to strip the code entirely. To put an upstream contract back to its real code, clear that account below.
    </p>
    <div class="panel">
      <div class="form-row">
        <label for="codeAddr">account</label>
        <input id="codeAddr" type="text" placeholder="0x… contract address">
      </div>
      <label class="field-label" for="codeHex">runtime bytecode</label>
      <textarea id="codeHex" placeholder="0x60806040… (paste 0x for no code)"></textarea>
      <div class="actions">
        <button id="setCode">Sign &amp; replace</button>
        <span id="codeStatus" class="status"></span>
      </div>
    </div>

    <h2>Clear sandbox</h2>
    <p class="muted" style="margin:.25rem 0 1rem">
      Discards sandbox state — overlay balances/nonces/code/storage plus the recorded sandbox transactions — so reads fall back through to the upstream chain. Leave both boxes empty to clear <strong>everything</strong>, or scope it by account: an account is cleared when it's allowed by <em>Only these</em> (blank = all) and not listed under <em>Except these</em>. This is an account-level reset, not a per-tx undo, and it can't be undone.
    </p>
    <div class="panel">
      <div class="clear-grid">
        <div>
          <label class="field-label" for="clearInclude">Only these accounts <span class="muted">(blank = all)</span></label>
          <textarea id="clearInclude" placeholder="0x… one per line (or comma/space separated)"></textarea>
        </div>
        <div>
          <label class="field-label" for="clearExclude">Except these accounts <span class="muted">(kept)</span></label>
          <textarea id="clearExclude" placeholder="0x… never cleared"></textarea>
        </div>
      </div>
      <div class="actions">
        <button id="clear" class="warn">Sign &amp; clear</button>
        <span id="clearStatus" class="status"></span>
      </div>
    </div>
  </div>`
    : `  <div class="panel" style="border-color:#f8514955">
    <strong style="color:#f85149">Admin tools are disabled.</strong>
    <div class="muted" style="margin-top:.4rem">No admins are configured. Add <code>"admins": ["0x..."]</code> to your config file and restart.</div>
  </div>`}

  <script>
    const chainIdHex = "${esc(chainIdHex)}";
    const chainIdDec = ${chainIdDec};
    const rpcUrl = window.location.origin + "/rpc";
    const adminSet = new Set([${adminSetLiteral}].map(s => s.toLowerCase()));

    const $ = (id) => document.getElementById(id);
    const statusEl = () => $("status");

    function setStatus(msg, kind) {
      const el = statusEl(); if (!el) return;
      el.textContent = msg || "";
      el.className = "status" + (kind ? " " + kind : "");
    }

    // --- EIP-55 checksum -----------------------------------------------------
    // Wallets (eth_accounts) and some RPCs hand us lowercase addresses; we always
    // render the checksummed form. Browsers have no keccak256, so we ship a tiny
    // self-contained Keccak-f[1600]. Inputs here are a single 40-byte ASCII block
    // (the lowercase hex address), so one absorb + one squeeze is all we need.
    function keccak256(bytes) {
      const RC = [
        [0x00000000,0x00000001],[0x00000000,0x00008082],[0x80000000,0x0000808a],[0x80000000,0x80008000],
        [0x00000000,0x0000808b],[0x00000000,0x80000001],[0x80000000,0x80008081],[0x80000000,0x00008009],
        [0x00000000,0x0000008a],[0x00000000,0x00000088],[0x00000000,0x80008009],[0x00000000,0x8000000a],
        [0x00000000,0x8000808b],[0x80000000,0x0000008b],[0x80000000,0x00008089],[0x80000000,0x00008003],
        [0x80000000,0x00008002],[0x80000000,0x00000080],[0x00000000,0x0000800a],[0x80000000,0x8000000a],
        [0x80000000,0x80008081],[0x80000000,0x00008080],[0x00000000,0x80000001],[0x80000000,0x80008008]
      ];
      const rotc = [1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44];
      const piln = [10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1];
      const s = new Array(25);
      for (let i=0;i<25;i++) s[i]=[0,0]; // each lane is [hi,lo] 32-bit halves
      const rate = 136; // keccak256: input < rate, so a single block
      const padded = new Uint8Array(rate);
      padded.set(bytes);
      padded[bytes.length] ^= 0x01;
      padded[rate-1] ^= 0x80;
      for (let i=0;i<rate/8;i++) {
        const lo = (padded[i*8] | (padded[i*8+1]<<8) | (padded[i*8+2]<<16) | (padded[i*8+3]<<24)) >>> 0;
        const hi = (padded[i*8+4] | (padded[i*8+5]<<8) | (padded[i*8+6]<<16) | (padded[i*8+7]<<24)) >>> 0;
        s[i][0] ^= hi; s[i][1] ^= lo;
      }
      function rotl(lane, n) {
        const hi=lane[0], lo=lane[1];
        if (n===0) return [hi>>>0, lo>>>0];
        if (n===32) return [lo>>>0, hi>>>0];
        if (n<32) return [ ((hi<<n)|(lo>>>(32-n)))>>>0, ((lo<<n)|(hi>>>(32-n)))>>>0 ];
        const m=n-32;
        return [ ((lo<<m)|(hi>>>(32-m)))>>>0, ((hi<<m)|(lo>>>(32-m)))>>>0 ];
      }
      const bc = new Array(5);
      for (let round=0; round<24; round++) {
        for (let i=0;i<5;i++) {
          bc[i] = [
            (s[i][0]^s[i+5][0]^s[i+10][0]^s[i+15][0]^s[i+20][0])>>>0,
            (s[i][1]^s[i+5][1]^s[i+10][1]^s[i+15][1]^s[i+20][1])>>>0
          ];
        }
        for (let i=0;i<5;i++) {
          const t = rotl(bc[(i+1)%5],1);
          const dhi = (bc[(i+4)%5][0]^t[0])>>>0;
          const dlo = (bc[(i+4)%5][1]^t[1])>>>0;
          for (let j=0;j<25;j+=5){ s[j+i][0]=(s[j+i][0]^dhi)>>>0; s[j+i][1]=(s[j+i][1]^dlo)>>>0; }
        }
        let last = [s[1][0], s[1][1]];
        for (let i=0;i<24;i++) {
          const j = piln[i];
          const tmp = [s[j][0], s[j][1]];
          const rot = rotl(last, rotc[i]);
          s[j][0]=rot[0]; s[j][1]=rot[1];
          last = tmp;
        }
        for (let j=0;j<25;j+=5) {
          for (let i=0;i<5;i++){ bc[i]=[s[j+i][0], s[j+i][1]]; }
          for (let i=0;i<5;i++){
            s[j+i][0]=(bc[i][0] ^ ((~bc[(i+1)%5][0]) & bc[(i+2)%5][0]))>>>0;
            s[j+i][1]=(bc[i][1] ^ ((~bc[(i+1)%5][1]) & bc[(i+2)%5][1]))>>>0;
          }
        }
        s[0][0]=(s[0][0]^RC[round][0])>>>0;
        s[0][1]=(s[0][1]^RC[round][1])>>>0;
      }
      const out = new Uint8Array(32);
      for (let i=0;i<4;i++) {
        const lo=s[i][1], hi=s[i][0];
        out[i*8+0]=lo&0xff; out[i*8+1]=(lo>>>8)&0xff; out[i*8+2]=(lo>>>16)&0xff; out[i*8+3]=(lo>>>24)&0xff;
        out[i*8+4]=hi&0xff; out[i*8+5]=(hi>>>8)&0xff; out[i*8+6]=(hi>>>16)&0xff; out[i*8+7]=(hi>>>24)&0xff;
      }
      return out;
    }

    // toChecksumAddress returns the EIP-55 mixed-case form of a 20-byte address.
    // Anything that isn't a 0x-prefixed 40-hex string is returned unchanged so it
    // is always safe to wrap a value of unknown shape before display.
    function toChecksumAddress(addr) {
      if (typeof addr !== "string") return addr;
      let a = addr.trim().toLowerCase();
      if (a.startsWith("0x")) a = a.slice(2);
      if (!/^[0-9a-f]{40}$/.test(a)) return addr;
      const ascii = new Uint8Array(40);
      for (let i=0;i<40;i++) ascii[i] = a.charCodeAt(i);
      const h = keccak256(ascii);
      let hex = "";
      for (let i=0;i<32;i++) hex += h[i].toString(16).padStart(2,"0");
      let out = "0x";
      for (let i=0;i<40;i++) {
        const c = a[i];
        out += (c >= "0" && c <= "9") ? c : (parseInt(hex[i],16) >= 8 ? c.toUpperCase() : c);
      }
      return out;
    }

    function shortAddr(a) { a = toChecksumAddress(a); return a.slice(0,6) + "…" + a.slice(-4); }

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

    let currentAddr = null;

    // applyAuth wires the connected address (already lowercased, possibly null)
    // into the page: it controls the wallet label, the admin pill, and whether
    // adminContent (mappings + add form) is revealed. Nothing about the current
    // impersonation state is shown until the wallet's address is a configured
    // admin — refresh() is only called from inside the admin branch.
    function applyAuth(addr) {
      currentAddr = addr || null;
      const walletEl = $("wallet");
      const badge = $("adminBadge");
      const msg = $("authMsg");
      const adminContent = $("adminContent");

      if (!currentAddr) {
        walletEl.textContent = "not connected";
        walletEl.classList.add("muted");
        badge.innerHTML = "";
        msg.style.display = "none";
        adminContent.hidden = true;
        return;
      }

      // currentAddr stays lowercased for the adminSet membership check below;
      // only the visible label is rendered checksummed.
      walletEl.textContent = toChecksumAddress(currentAddr);
      walletEl.classList.remove("muted");

      if (adminSet.has(currentAddr)) {
        badge.innerHTML = '<span class="pill admin">admin</span>';
        msg.style.display = "none";
        adminContent.hidden = false;
        refresh();
      } else {
        badge.innerHTML = '<span class="pill bad">not an admin</span>';
        msg.textContent = "This account is not a configured admin; admin tools are hidden. Switch to an admin account in your wallet.";
        msg.style.display = "block";
        adminContent.hidden = true;
      }
    }

    async function connect() {
      if (!window.ethereum) { setStatus("no injected wallet detected", "err"); return; }
      try {
        const accts = await window.ethereum.request({method: "eth_requestAccounts"});
        applyAuth((accts[0] || "").toLowerCase() || null);
      } catch (e) {
        setStatus(e.message || String(e), "err");
      }
    }

    function eip712Domain() {
      return { name: "fakereum-impersonate", version: "1", chainId: chainIdDec };
    }

    function setImpersonatorPayload(signer, identity) {
      return {
        domain: eip712Domain(),
        types: {
          EIP712Domain: [
            {name:"name",    type:"string"},
            {name:"version", type:"string"},
            {name:"chainId", type:"uint256"},
          ],
          SetImpersonator: [
            {name:"impersonator", type:"address"},
            {name:"impersonatee", type:"address"},
          ],
        },
        primaryType: "SetImpersonator",
        message: { impersonator: signer, impersonatee: identity },
      };
    }

    function removeImpersonatorPayload(signer) {
      return {
        domain: eip712Domain(),
        types: {
          EIP712Domain: [
            {name:"name",    type:"string"},
            {name:"version", type:"string"},
            {name:"chainId", type:"uint256"},
          ],
          RemoveImpersonator: [
            {name:"impersonator", type:"address"},
          ],
        },
        primaryType: "RemoveImpersonator",
        message: { impersonator: signer },
      };
    }

    async function signTyped(payload) {
      if (!currentAddr) throw new Error("connect wallet first");
      return await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [currentAddr, JSON.stringify(payload)],
      });
    }

    function validAddress(s) { return /^0x[0-9a-fA-F]{40}$/.test(s); }

    async function refresh() {
      const tbody = $("mappings").querySelector("tbody");
      tbody.innerHTML = '<tr><td colspan="4" class="empty">loading…</td></tr>';
      try {
        const m = await rpc("fakereum_listImpersonators", []);
        const rows = [];
        for (const identity of Object.keys(m).sort()) {
          for (const signer of m[identity]) {
            rows.push({identity, signer});
          }
        }
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="empty">no mappings yet</td></tr>';
          return;
        }
        tbody.innerHTML = "";
        for (const {identity, signer} of rows) {
          const tr = document.createElement("tr");
          tr.innerHTML =
            '<td class="mono">' + toChecksumAddress(signer) + '</td>' +
            '<td class="arrow">→</td>' +
            '<td class="mono">' + toChecksumAddress(identity) + '</td>' +
            '<td style="text-align:right"><button class="danger" data-signer="' + signer + '">remove</button></td>';
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll("button.danger").forEach(btn => {
          btn.addEventListener("click", () => removeMapping(btn.getAttribute("data-signer")));
        });
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">load failed: ' + (e.message || e) + '</td></tr>';
      }
    }

    async function addMapping() {
      setStatus("", "");
      const signer   = $("newSigner").value.trim();
      const identity = $("newIdentity").value.trim();
      if (!validAddress(signer) || !validAddress(identity)) { setStatus("both fields must be 0x-prefixed 20-byte addresses", "err"); return; }
      if (signer.toLowerCase() === identity.toLowerCase()) { setStatus("impersonator and impersonatee must differ", "err"); return; }
      if (!currentAddr) { setStatus("connect wallet first", "err"); return; }
      try {
        setStatus("waiting for wallet signature…");
        const sig = await signTyped(setImpersonatorPayload(signer, identity));
        setStatus("submitting…");
        await rpc("fakereum_setImpersonator", [{impersonator: signer, impersonatee: identity, signature: sig}]);
        setStatus("added " + shortAddr(signer) + " → " + shortAddr(identity), "ok");
        $("newSigner").value = "";
        $("newIdentity").value = "";
        refresh();
      } catch (e) {
        setStatus(e.message || String(e), "err");
      }
    }

    async function removeMapping(signer) {
      if (!currentAddr) { setStatus("connect wallet first", "err"); return; }
      try {
        setStatus("waiting for wallet signature…");
        const sig = await signTyped(removeImpersonatorPayload(signer));
        setStatus("submitting…");
        await rpc("fakereum_removeImpersonator", [{impersonator: signer, signature: sig}]);
        setStatus("removed " + shortAddr(signer), "ok");
        refresh();
      } catch (e) {
        setStatus(e.message || String(e), "err");
      }
    }

    // --- Clear sandbox --------------------------------------------------------
    // Admin-gated like impersonation: the include/exclude scope is signed
    // EIP-712 and verified server-side against cfg.Admins. Inputs persist across
    // reloads in localStorage, keyed per chain id so different sandboxes don't
    // share scopes.
    const clearKey = "fakereum.clearSandbox." + chainIdDec;

    function setClearStatus(msg, kind) {
      const el = $("clearStatus"); if (!el) return;
      el.textContent = msg || "";
      el.className = "status" + (kind ? " " + kind : "");
    }

    function loadClearInputs() {
      try {
        const s = JSON.parse(localStorage.getItem(clearKey) || "{}");
        if (typeof s.include === "string") $("clearInclude").value = s.include;
        if (typeof s.exclude === "string") $("clearExclude").value = s.exclude;
      } catch (e) { /* ignore malformed/blocked storage */ }
    }

    function saveClearInputs() {
      try {
        localStorage.setItem(clearKey, JSON.stringify({
          include: $("clearInclude").value,
          exclude: $("clearExclude").value,
        }));
      } catch (e) { /* ignore quota/blocked storage */ }
    }

    // parseAddrList splits on commas / whitespace / newlines and validates each
    // entry, returning {addrs, bad} so the caller can surface bad input.
    function parseAddrList(text) {
      const parts = text.split(/[\\s,]+/).map(x => x.trim()).filter(Boolean);
      return { addrs: parts, bad: parts.filter(x => !validAddress(x)) };
    }

    function clearSandboxPayload(include, exclude) {
      return {
        domain: eip712Domain(),
        types: {
          EIP712Domain: [
            {name:"name",    type:"string"},
            {name:"version", type:"string"},
            {name:"chainId", type:"uint256"},
          ],
          ClearSandbox: [
            {name:"include", type:"address[]"},
            {name:"exclude", type:"address[]"},
          ],
        },
        primaryType: "ClearSandbox",
        message: { include, exclude },
      };
    }

    async function clearSandbox() {
      const inc = parseAddrList($("clearInclude").value);
      const exc = parseAddrList($("clearExclude").value);
      const bad = inc.bad.concat(exc.bad);
      if (bad.length) { setClearStatus("invalid address: " + bad.join(", "), "err"); return; }
      if (!currentAddr) { setClearStatus("connect an admin wallet first", "err"); return; }
      const scope = inc.addrs.length
        ? inc.addrs.length + " account(s)" + (exc.addrs.length ? " (minus " + exc.addrs.length + ")" : "")
        : exc.addrs.length ? "everything except " + exc.addrs.length + " account(s)"
        : "ALL sandbox state";
      if (!confirm("Clear " + scope + "?\\n\\nThis discards overlay state and sandbox txs, and cannot be undone.")) return;
      try {
        setClearStatus("waiting for wallet signature…");
        const sig = await signTyped(clearSandboxPayload(inc.addrs, exc.addrs));
        setClearStatus("submitting…");
        const r = await rpc("fakereum_clearSandbox", [{include: inc.addrs, exclude: exc.addrs, signature: sig}]);
        setClearStatus("cleared " + r.overlayCleared + " overlay account(s) and " + r.txsCleared + " tx(s)", "ok");
      } catch (e) {
        setClearStatus(e.message || String(e), "err");
      }
    }

    // --- Replace bytecode -----------------------------------------------------
    // Admin-gated like the others: the (account, code) pair is signed EIP-712
    // over the SetCode type and verified server-side against cfg.Admins. code is
    // an EIP-712 dynamic bytes value, so the wallet hashes keccak256(code) — the
    // server rebuilds the same digest from the raw bytes.
    function setCodeStatus(msg, kind) {
      const el = $("codeStatus"); if (!el) return;
      el.textContent = msg || "";
      el.className = "status" + (kind ? " " + kind : "");
    }

    function normalizeCode(text) {
      let c = (text || "").trim().replace(/\\s+/g, "");
      if (c === "") c = "0x";
      if (!c.startsWith("0x")) c = "0x" + c;
      return c;
    }

    function validBytes(c) { return /^0x([0-9a-fA-F]{2})*$/.test(c); }

    function setCodePayload(account, code) {
      return {
        domain: eip712Domain(),
        types: {
          EIP712Domain: [
            {name:"name",    type:"string"},
            {name:"version", type:"string"},
            {name:"chainId", type:"uint256"},
          ],
          SetCode: [
            {name:"account", type:"address"},
            {name:"code",    type:"bytes"},
          ],
        },
        primaryType: "SetCode",
        message: { account, code },
      };
    }

    async function replaceCode() {
      const account = $("codeAddr").value.trim();
      const code = normalizeCode($("codeHex").value);
      if (!validAddress(account)) { setCodeStatus("account must be a 0x-prefixed 20-byte address", "err"); return; }
      if (!validBytes(code)) { setCodeStatus("bytecode must be 0x-prefixed even-length hex", "err"); return; }
      if (!currentAddr) { setCodeStatus("connect an admin wallet first", "err"); return; }
      const bytes = (code.length - 2) / 2;
      const what = bytes === 0 ? "strip code at " + shortAddr(account) : "replace code at " + shortAddr(account) + " (" + bytes + " bytes)";
      if (!confirm(what.charAt(0).toUpperCase() + what.slice(1) + "?\\n\\nThis overrides the account's bytecode and is not a per-tx undo.")) return;
      try {
        setCodeStatus("waiting for wallet signature…");
        const sig = await signTyped(setCodePayload(account, code));
        setCodeStatus("submitting…");
        const r = await rpc("fakereum_setCode", [{account, code, signature: sig}]);
        setCodeStatus((r.codeSize === 0 ? "stripped code at " : "replaced code at ") + shortAddr(r.account) + " (" + r.codeSize + " bytes)", "ok");
      } catch (e) {
        setCodeStatus(e.message || String(e), "err");
      }
    }

    if (${enabledJs}) {
      $("connect").addEventListener("click", connect);
      $("add").addEventListener("click", addMapping);
      $("setCode").addEventListener("click", replaceCode);
      $("clear").addEventListener("click", clearSandbox);
      $("clearInclude").addEventListener("input", saveClearInputs);
      $("clearExclude").addEventListener("input", saveClearInputs);
      loadClearInputs();
      // Auto-detect a previously-authorized account without forcing a popup.
      // refresh() is intentionally NOT called here — applyAuth gates it on
      // admin status so non-admin visitors never see the mapping list.
      if (window.ethereum) {
        window.ethereum.request({method: "eth_accounts"}).then(accts => {
          applyAuth(((accts && accts[0]) || "").toLowerCase() || null);
        }).catch(() => {});
        // Re-gate when the user switches accounts in their wallet UI.
        if (typeof window.ethereum.on === "function") {
          window.ethereum.on("accountsChanged", (accts) => {
            applyAuth(((accts && accts[0]) || "").toLowerCase() || null);
          });
        }
      }
    }
  </script>
</body>
</html>`
}
