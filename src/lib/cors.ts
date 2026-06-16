// CORS allowlist + the no-store header trio. Mirrors proxy.go's cors handling.
//
// Empty allowlist => "*" (any origin). Non-empty => echo Origin only on exact
// match, with `Vary: Origin`. Every HTTP response (except the WS upgrade, which
// bypasses CORS) carries the no-store trio so browsers never cache mutable
// chain data.

export interface CorsConfig {
  /** Exact-match allowlist. Empty => wildcard "*". */
  origins: string[]
}

const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Expires: '0',
}

/** Apply the no-store trio onto a Headers object (in place). */
export function applyNoStore(h: Headers): void {
  for (const [k, v] of Object.entries(NO_STORE)) h.set(k, v)
}

/** Resolve the Access-Control-Allow-Origin value for a request Origin. */
export function corsHeaders(cfg: CorsConfig, origin: string | null): Record<string, string> {
  const out: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
  if (cfg.origins.length === 0) {
    out['Access-Control-Allow-Origin'] = '*'
  } else if (origin && cfg.origins.includes(origin)) {
    out['Access-Control-Allow-Origin'] = origin
    out['Vary'] = 'Origin'
  }
  return out
}

/** Build a 204 preflight response. */
export function preflight(cfg: CorsConfig, origin: string | null): Response {
  const h = new Headers(corsHeaders(cfg, origin))
  applyNoStore(h)
  return new Response(null, { status: 204, headers: h })
}

/** Merge CORS + no-store onto an existing Headers object (in place). */
export function decorate(cfg: CorsConfig, origin: string | null, h: Headers): void {
  for (const [k, v] of Object.entries(corsHeaders(cfg, origin))) h.set(k, v)
  applyNoStore(h)
}
