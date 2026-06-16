// Per-IP token-bucket rate limiter. Ports rate_limit.go's shape.
//
// NOTE: in Workers this lives in front-Worker isolate memory, so the bucket is
// per-isolate (approximate) rather than globally exact like the Go single
// process. For strict global limiting, front it with Cloudflare's native Rate
// Limiting binding or a limiter Durable Object. Disabled when rps <= 0.

import { ipInAny, parseIPNets, type IPNet } from './ipnet'

interface Bucket {
  tokens: number
  last: number // ms
}

export class RateLimiter {
  private readonly burst: number
  private readonly exempt: IPNet[]
  private buckets = new Map<string, Bucket>()

  constructor(
    private readonly rps: number,
    burst = 0,
    exempt: string[] = [],
  ) {
    this.burst = burst > 0 ? burst : Math.max(Math.floor(2 * rps), 1)
    this.exempt = parseIPNets(exempt)
  }

  static fromConfig(rps: number, exempt: string[] = []): RateLimiter | null {
    return rps > 0 ? new RateLimiter(rps, 0, exempt) : null
  }

  /** True iff `ip` is allowlisted and bypasses the bucket entirely. */
  isExempt(ip: string): boolean {
    return ipInAny(this.exempt, ip)
  }

  /** True = allowed. On deny, retryAfter is the ceil seconds until a token. */
  check(ip: string): { ok: boolean; retryAfter: number } {
    if (this.isExempt(ip)) return { ok: true, retryAfter: 0 }
    const now = Date.now()
    let b = this.buckets.get(ip)
    if (!b) {
      // Fresh bucket starts full -> the first request is never throttled.
      b = { tokens: this.burst, last: now }
      this.buckets.set(ip, b)
    } else {
      const elapsed = (now - b.last) / 1000
      b.tokens = Math.min(this.burst, b.tokens + elapsed * this.rps)
      b.last = now
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true, retryAfter: 0 }
    }
    const need = 1 - b.tokens
    const retryAfter = Math.max(1, Math.ceil(need / this.rps))
    return { ok: false, retryAfter }
  }
}
