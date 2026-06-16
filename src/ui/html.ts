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

/** Build a complete HTML Response with the no-store-friendly content type. */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// Shared CSS — keeps the explorer/admin/list pages visually consistent
// (verbatim from tx_explorer.go's explorerCSS).
export const explorerCSS = `
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 880px; margin: 3rem auto; padding: 0 1.25rem; background:#0e1116; color:#e6edf3; }
  a { color:#58a6ff; }
  h1 { margin: 0 0 .25rem; font-size: 1.35rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .tag { color:#7d8590; font-size: .85rem; letter-spacing:.05em; text-transform: uppercase; }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: .35rem .75rem; margin: 1.5rem 0 2rem; }
  dt { color:#7d8590; }
  dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .ok  { color:#3fb950; }
  .err { color:#f85149; }
  details { margin: 1rem 0; }
  summary { color:#7d8590; cursor:pointer; }
  pre { background:#161b22; padding:.75rem; border-radius:6px; overflow-x:auto; font-size:13px; }
  .log { border:1px solid #30363d; border-radius:6px; padding:.75rem 1rem; margin:.5rem 0; background:#0d1117; }
  .log dt { font-size:.85rem; }
  .log dd { font-size:.85rem; }
  .topics { margin:.25rem 0; padding-left:1rem; }
  .topics li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.82rem; color:#a5d6ff; }
  .nav { margin-bottom: 1rem; }
  .nav a { text-decoration:none; color:#7d8590; }
  .nav a:hover { color:#58a6ff; }
  .muted { color:#7d8590; font-size:.9rem; }
  .decoded { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem; background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:.5rem .75rem; margin:.5rem 0; }
  .decoded .method  { color:#d2a8ff; }
  .decoded .argname { color:#7ee787; }
  .decoded .argtype { color:#7d8590; }
  .decoded .argval  { color:#e6edf3; word-break:break-all; }
  .decoded .indexed { color:#f0883e; font-size:.75rem; padding:.05em .35em; border:1px solid #f0883e; border-radius:3px; }
  .pill { display:inline-block; padding:.1em .55em; border-radius:999px; font-size:.75rem; border:1px solid #30363d; color:#7d8590; margin-left:.4em; vertical-align:middle; }
  .pill.sandbox { color:#d2a8ff; border-color:#6e40c9; }
  .pill.err { color:#f85149; border-color:#f85149; }
  .diffpre  { color:#f85149; }
  .diffpost { color:#3fb950; }
  table.slots { width:100%; border-collapse:collapse; margin:.25rem 0; font-size:.82rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table.slots th, table.slots td { border-bottom:1px solid #30363d; padding:.3rem .5rem; text-align:left; word-break:break-all; }
  table.slots th { color:#7d8590; font-weight:normal; font-family: ui-sans-serif, system-ui, sans-serif; }
  button.undo { background:#21262d; color:#e6edf3; border:1px solid #30363d; padding:.4rem .9rem; font: inherit; font-size:.85rem; border-radius:6px; cursor:pointer; }
  button.undo:hover { background:#30363d; border-color:#484f58; }
  button.undo.small { padding:.1rem .45rem; font-size:.9rem; line-height:1; }
`
