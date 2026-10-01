// Read-only client for an upstream Esplora API (mempool.space, blockstream.info
// or any electrs-based instance). Several base URLs fail over in order; every
// request has a deadline so a stuck endpoint cannot hold the sandbox open.

export class EsploraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`upstream HTTP ${status}`)
  }
}

export class EsploraUpstream {
  constructor(
    private readonly bases: string[],
    private readonly timeoutMs: number,
  ) {}

  get configured(): boolean {
    return this.bases.length > 0
  }

  /**
   * GET `path` from the first base that answers. A 4xx is the upstream's
   * answer (e.g. 404 for an unknown tx) and is thrown as-is rather than failed
   * over; a transport error, timeout or 5xx / 429 moves on to the next base.
   */
  async raw(path: string): Promise<{ status: number; contentType: string; body: string }> {
    let lastErr: unknown = new Error('no upstream Esplora configured')
    for (const base of this.bases) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), this.timeoutMs)
      try {
        const r = await fetch(base + path, { signal: abort.signal, headers: { Accept: 'application/json, text/plain' } })
        const body = await r.text()
        if (r.status >= 500 || r.status === 429) {
          lastErr = new EsploraHttpError(r.status, body)
          continue
        }
        return { status: r.status, contentType: r.headers.get('content-type') ?? 'text/plain', body }
      } catch (e) {
        lastErr = abort.signal.aborted ? new Error(`upstream did not answer within ${this.timeoutMs / 1000}s`) : e
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr
  }

  async json<T>(path: string): Promise<T> {
    const r = await this.raw(path)
    if (r.status !== 200) throw new EsploraHttpError(r.status, r.body)
    return JSON.parse(r.body) as T
  }

  async text(path: string): Promise<string> {
    const r = await this.raw(path)
    if (r.status !== 200) throw new EsploraHttpError(r.status, r.body)
    return r.body.trim()
  }

  /** Current tip: height, hash and block time. */
  async tip(): Promise<{ height: number; hash: string; time: number }> {
    const [height, hash] = await Promise.all([this.text('/blocks/tip/height'), this.text('/blocks/tip/hash')])
    const block = await this.json<{ timestamp: number }>(`/block/${hash}`)
    return { height: Number(height), hash, time: block.timestamp }
  }
}
