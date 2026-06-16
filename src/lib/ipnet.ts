// IPv4/IPv6 address + CIDR parsing and containment. Backs RATE_LIMIT_EXEMPT,
// mirroring rate_limit.go's use of net.ParseCIDR / net.IP.Contains.
//
// Everything is normalized to a 16-byte representation: IPv4 addresses are
// mapped into ::ffff:0:0/96 so a single prefix-bit comparison works across both
// families (an IPv4 CIDR /n becomes a 16-byte prefix of length 96+n).

export interface IPNet {
  /** Network address, always 16 bytes (IPv4 mapped into ::ffff:0:0/96). */
  addr: Uint8Array
  /** Prefix length in bits over the 16-byte form, in [0, 128]. */
  bits: number
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const

function parseIPv4(s: string): Uint8Array | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const p = parts[i]
    if (p === undefined || !/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseIPv6(s: string): Uint8Array | null {
  if (!s.includes(':')) return null

  // A trailing embedded IPv4 ("...:a.b.c.d") is rewritten as two hextets.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    const h1 = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0)
    const h2 = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)
    s = s.slice(0, lastColon + 1) + h1.toString(16) + ':' + h2.toString(16)
  }

  const halves = s.split('::')
  if (halves.length > 2) return null

  const toGroups = (str: string): number[] | null => {
    if (str === '') return []
    const out: number[] = []
    for (const g of str.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }

  let groups: number[]
  if (halves.length === 2) {
    const head = toGroups(halves[0] ?? '')
    const tailG = toGroups(halves[1] ?? '')
    if (head === null || tailG === null) return null
    const fill = 8 - head.length - tailG.length
    if (fill < 1) return null // "::" must stand for at least one zero group
    groups = [...head, ...new Array<number>(fill).fill(0), ...tailG]
  } else {
    const all = toGroups(s)
    if (all === null) return null
    groups = all
  }
  if (groups.length !== 8) return null

  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? 0
    out[i * 2] = (g >> 8) & 0xff
    out[i * 2 + 1] = g & 0xff
  }
  return out
}

/** Parse an IP literal to its raw bytes (4 for IPv4, 16 for IPv6), or null. */
export function parseIP(s: string): Uint8Array | null {
  if (s.includes(':')) return parseIPv6(s)
  return parseIPv4(s)
}

function to16(ip: Uint8Array): Uint8Array {
  if (ip.length === 16) return ip
  const out = new Uint8Array(16)
  out.set(V4_MAPPED_PREFIX, 0)
  out.set(ip, 12)
  return out
}

function parseCIDR(s: string): IPNet | null {
  const slash = s.indexOf('/')
  const addrStr = s.slice(0, slash)
  const prefixStr = s.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixStr)) return null
  const ip = parseIP(addrStr)
  if (!ip) return null
  const prefix = Number(prefixStr)
  const max = ip.length === 4 ? 32 : 128
  if (prefix > max) return null
  return { addr: to16(ip), bits: ip.length === 4 ? 96 + prefix : prefix }
}

/** Parse a single host ("10.0.0.1", "::1") or a CIDR ("10.0.0.0/8"), or null. */
export function parseIPNet(s: string): IPNet | null {
  if (s.includes('/')) return parseCIDR(s)
  const ip = parseIP(s)
  if (!ip) return null
  return { addr: to16(ip), bits: 128 } // single host
}

/** True iff `ip` (raw bytes from parseIP) falls inside `net`. */
export function netContains(net: IPNet, ip: Uint8Array): boolean {
  const ip16 = to16(ip)
  const fullBytes = net.bits >>> 3
  const remBits = net.bits & 7
  for (let i = 0; i < fullBytes; i++) {
    if ((net.addr[i] ?? 0) !== (ip16[i] ?? 0)) return false
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff
    if (((net.addr[fullBytes] ?? 0) & mask) !== ((ip16[fullBytes] ?? 0) & mask)) return false
  }
  return true
}

/** Compile an allowlist of IP/CIDR strings; invalid entries are warned + skipped. */
export function parseIPNets(entries: string[]): IPNet[] {
  const nets: IPNet[] = []
  for (const e of entries) {
    const n = parseIPNet(e)
    if (n) nets.push(n)
    else console.warn(`rate_limit_exempt: skip invalid entry ${JSON.stringify(e)}`)
  }
  return nets
}

/** True iff `ipStr` parses and matches any net in `nets`. */
export function ipInAny(nets: IPNet[], ipStr: string): boolean {
  if (nets.length === 0) return false
  const ip = parseIP(ipStr)
  if (!ip) return false
  for (const n of nets) if (netContains(n, ip)) return true
  return false
}
