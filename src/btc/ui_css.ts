// Stylesheet for the BTC explorer pages. Tokens and component proportions come
// from the mempool UI handoff (dark theme only: the source offers no light one).

export const BTC_CSS = `
:root{
  --bg:#11131f;--page:#000;--box-bg:#171c2a;--secondary:#272f4e;--tertiary:#6225b2;
  --primary:#007cfa;--mainnet-alt:#9339f4;--title-fg:#2055e3;--info:#00ddff;--success:#0aab2f;
  --green:#83fd00;--yellow:#fff000;--red:#ff3d00;--orange:#ff9f00;--danger:#dc3545;
  --fg:#fff;--muted:#ffffffbb;--faint:rgba(255,255,255,.4);--line:rgba(255,255,255,.11);
  --block-top:#232838;--block-side:#191c27;--mempool-block-top:#403834;--mempool-block-side:#2d2825;
  --f:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","Noto Sans","Liberation Sans",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
html{background:var(--page)}
body{margin:0;background:var(--page);color:var(--fg);font:16px/1.5 var(--f)}
a{color:var(--info);text-decoration:none}
a:hover{color:rgb(0,155,179)}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--info);outline-offset:2px}
.mono{font-family:var(--mono);font-size:13px;word-break:break-all}
small,.u{font-size:12px;color:var(--muted)}

nav.top{min-height:64px;background:var(--bg);display:flex;align-items:center;gap:16px;padding:0 32px;box-shadow:0 0 15px #000;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:8px;font-weight:500;line-height:1;color:var(--fg)}
.logo:hover{color:var(--fg)}
.logo i{width:34px;height:34px;border-radius:4px;background:linear-gradient(180deg,#5b4fd8 0 55%,#6fe3ff 55%)}
.logo span{display:flex;flex-direction:column;font-size:22px}
.logo span small{font-size:18px;color:var(--mainnet-alt);margin-top:-2px}
.net{background:var(--secondary);border-radius:4px;height:36px;padding:0 12px;display:flex;align-items:center;gap:6px;font-size:12px}
.net b{width:18px;height:18px;border-radius:50%;background:#f7931a;display:inline-block}
.tabs{display:flex;height:64px}
.tabs a{min-width:58px;padding:0 14px;height:64px;display:grid;place-items:center;color:#f1f1f1;font-size:14px}
.tabs a.on{background:var(--tertiary)}
form.search{margin-left:auto;display:flex;gap:10px;flex:1 1 280px;justify-content:flex-end}
.in{width:381px;max-width:100%;height:38px;background:var(--secondary);border:1px solid rgba(17,19,31,.2);border-radius:4px;color:#fff;padding:6px 12px;font:16px var(--f)}
.in::placeholder{color:rgba(255,255,255,.55)}
.btn{height:38px;min-width:62px;background:var(--tertiary);border:1px solid var(--tertiary);border-radius:4px;color:#fff;padding:6px 12px;font:16px var(--f);cursor:pointer}
.btn:hover{filter:brightness(1.12)}

.wrap{max-width:1182px;margin:0 auto;padding:0 15px}
.strip{overflow-x:auto;padding:76px 15px 56px}
.blocks{display:flex;gap:30px;align-items:flex-end;width:max-content;margin:0 auto}
.blk{position:relative;display:block;width:125px;height:125px;margin:20px 0 0 20px;text-align:center;font-size:12px;line-height:1.35;color:var(--fg)}
.blk:hover{color:var(--fg);filter:brightness(1.12)}
.blk::before{content:"";position:absolute;left:-20px;top:0;width:20px;height:125px;background:var(--side);transform:skewY(45deg);transform-origin:100% 0}
.blk::after{content:"";position:absolute;left:0;top:-20px;width:125px;height:20px;background:var(--top);transform:skewX(45deg);transform-origin:0 100%}
.blk .body{position:relative;height:100%;padding-top:16px;display:flex;flex-direction:column;gap:2px;background:var(--fill)}
.blk .range{color:var(--yellow);font-size:11px}
.blk .big{font-size:16px;font-weight:700;margin:4px 0}
.blk .tx{font-size:11px;color:var(--muted)}
.blk .time{font-size:13px;margin-top:4px}
.blk .h{position:absolute;top:-56px;left:0;right:0;color:var(--info);font-size:16px}
.blk .pool{position:absolute;bottom:-30px;left:-20px;right:0;font-size:12px;font-weight:700}
.blk.proj{--side:var(--mempool-block-side);--top:var(--mempool-block-top);--fill:linear-gradient(180deg,#6d7d04,#5d6b04)}
.blk.mined{--side:var(--block-side);--top:var(--block-top);--fill:linear-gradient(180deg,var(--mainnet-alt),var(--primary))}
.blk.real{--fill:linear-gradient(180deg,#3a3f5c,#2a2f48)}
.divider{width:0;height:180px;border-left:3px dashed #fff;opacity:.9;align-self:center}

.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px;margin-bottom:30px}
.grid>*{min-width:0}
.eyebrow{font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.02em;text-align:center;margin-bottom:8px}
.card{background:var(--bg);border:1px solid rgba(0,0,0,.176);border-radius:4px;padding:20px;min-width:0}
.card h2{margin:0 0 14px;text-align:center;color:var(--title-fg);font-size:16px;font-weight:500}
.card+.card{margin-top:30px}
.feebar{display:flex;height:22px;border-radius:0 10px 10px 0;overflow:hidden;font-size:13px}
.feebar>div{display:grid;place-items:center;white-space:nowrap}
.feebar .np{background:#007d3d;width:122px}
.feebar .sep{width:24px;background:repeating-linear-gradient(90deg,var(--secondary) 0 2px,var(--bg) 2px 4px)}
.feebar .pr{flex:1;background:linear-gradient(to right,#007d3d,#7d7d06)}
.stats{display:flex;justify-content:space-around;text-align:center;gap:16px;flex-wrap:wrap;margin-top:16px}
.stats .v{font-size:20px}
.stats .v small{margin-left:4px}
.stats .l{font-size:13px;color:var(--muted)}
.bar{height:22px;background:var(--secondary);position:relative;border-radius:4px;overflow:hidden}
.bar i{position:absolute;inset:0 7% 0 0;background:linear-gradient(90deg,#2486eb,#ae6af7)}

table.t{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.t th{font-weight:700;text-align:right;padding:11px 12px 12px;white-space:nowrap}
.t td{padding:10px 12px;text-align:right;vertical-align:top}
.t th:first-child,.t td:first-child{text-align:left}
.t .usd,.pos{color:var(--green)}
.scroll{overflow-x:auto}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 4.8px;border-radius:4px;line-height:1;color:#fff;background:var(--success)}
.badge.faucet{background:var(--tertiary)}
.badge.sbx{background:var(--secondary)}
.badge.full{background:var(--info);color:#11131f}
.badge.cb{background:var(--orange);color:#11131f}

h1.page{font-size:24px;font-weight:500;margin:30px 0 4px;word-break:break-all}
h1.page small{display:block;font-size:13px;margin-top:2px}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 24px;margin:0}
.kv dt{color:var(--muted)}
.kv dd{margin:0;min-width:0;word-break:break-all}
.hdr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:start}

.txcard{background:var(--bg);border:1px solid rgba(0,0,0,.176);border-radius:4px;padding:20px;margin-bottom:20px}
.txhead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:12px}
.io{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);gap:8px}
.io ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.io li{display:flex;justify-content:space-between;gap:12px;background:var(--box-bg);border-radius:4px;padding:6px 10px;min-width:0}
.io li .a{min-width:0;word-break:break-all;font-size:13px}
.io li .n{white-space:nowrap;font-size:13px}
.io .arrow{align-self:center;text-align:center;color:var(--faint)}
.txfoot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;align-items:center}
.chip{display:inline-block;background:var(--secondary);border-radius:4px;padding:2px 8px;font-size:13px}
.chip.ok{background:var(--success)}

.note{background:var(--box-bg);border-radius:4px;padding:14px 16px;color:var(--muted);font-size:14px}
pre.code{background:var(--box-bg);border-radius:4px;padding:12px;overflow:auto;font:12.5px var(--mono);margin:0}
form.faucet{display:flex;flex-direction:column;gap:10px}
form.faucet .row{display:flex;gap:10px;flex-wrap:wrap}
form.faucet .in{flex:1 1 200px;width:auto}
#faucet-out{font-size:13px;word-break:break-all;min-height:20px}

footer{background:var(--bg);margin-top:50px;padding:24px 32px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}
footer b{display:block;color:var(--title-fg);font-size:13px;margin-bottom:4px}
footer a,footer span{display:block;color:var(--faint);font-size:13px;line-height:1.8}
footer a:hover{color:#fff}

@media (max-width:860px){
  nav.top{padding:8px 16px}
  form.search{flex-basis:100%;margin-left:0}
  .grid{grid-template-columns:minmax(0,1fr)}
  .io{grid-template-columns:minmax(0,1fr)}
  .io .arrow{display:none}
  .hdr{grid-template-columns:minmax(0,1fr)}
  .kv{grid-template-columns:minmax(0,1fr);gap:0}
  .kv dt{margin-top:10px;font-size:13px}
  .strip{padding-left:0;padding-right:0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`
