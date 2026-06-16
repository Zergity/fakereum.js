import { describe, expect, it } from 'vitest'
import { ipInAny, parseIP, parseIPNet, parseIPNets } from '../src/lib/ipnet'

describe('parseIP', () => {
  it('parses IPv4', () => {
    expect(parseIP('10.1.2.3')).toEqual(Uint8Array.of(10, 1, 2, 3))
  })
  it('parses IPv6 loopback', () => {
    expect(parseIP('::1')).toEqual(
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
    )
  })
  it('parses IPv6 with embedded IPv4', () => {
    expect(parseIP('::ffff:1.2.3.4')).toEqual(
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4),
    )
  })
  it('rejects junk', () => {
    expect(parseIP('999.0.0.1')).toBeNull()
    expect(parseIP('10.0.0')).toBeNull()
    expect(parseIP('::g')).toBeNull()
    expect(parseIP('not-an-ip')).toBeNull()
  })
})

describe('parseIPNet', () => {
  it('treats a bare host as a /32 or /128', () => {
    expect(parseIPNet('127.0.0.1')?.bits).toBe(128) // 96 + 32 in mapped space
    expect(parseIPNet('::1')?.bits).toBe(128)
  })
  it('parses CIDR', () => {
    expect(parseIPNet('10.0.0.0/8')?.bits).toBe(104) // 96 + 8 in mapped space
  })
  it('rejects out-of-range prefixes', () => {
    expect(parseIPNet('10.0.0.0/33')).toBeNull()
    expect(parseIPNet('::/129')).toBeNull()
  })
})

describe('ipInAny', () => {
  const nets = parseIPNets(['127.0.0.1', '::1', '10.0.0.0/8'])

  it('matches exact hosts', () => {
    expect(ipInAny(nets, '127.0.0.1')).toBe(true)
    expect(ipInAny(nets, '::1')).toBe(true)
  })
  it('matches inside the CIDR', () => {
    expect(ipInAny(nets, '10.0.0.1')).toBe(true)
    expect(ipInAny(nets, '10.255.255.254')).toBe(true)
  })
  it('rejects outside the CIDR', () => {
    expect(ipInAny(nets, '11.0.0.1')).toBe(false)
    expect(ipInAny(nets, '9.255.255.255')).toBe(false)
    expect(ipInAny(nets, '127.0.0.2')).toBe(false)
    expect(ipInAny(nets, '::2')).toBe(false)
  })
  it('does not confuse v4 and v6', () => {
    // ::1 must not be treated as inside the IPv4 10.0.0.0/8 range.
    expect(ipInAny(parseIPNets(['10.0.0.0/8']), '::a00:1')).toBe(false)
  })
  it('empty allowlist matches nothing', () => {
    expect(ipInAny([], '127.0.0.1')).toBe(false)
  })
})
