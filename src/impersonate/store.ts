// The B->A impersonation map + the byte-level address-slot rewriting
// primitives. Ports impersonate.go (Impersonators). Many-to-one: several
// impersonators B may map to one impersonatee A; the unambiguous reverse index
// (A with exactly one B) drives response relabeling.

import {
  addrKey,
  addrEq,
  bytesToHex,
  checksumAddress,
  hexToBytes,
  toAddress,
  type Hex,
} from '../lib/hex'

export class Impersonators {
  /** bKey -> A (checksummed). */
  private m = new Map<string, Hex>()
  /** aKey -> unique B (checksummed); only for A with exactly one impersonator. */
  private inv = new Map<string, Hex>()
  /** set of impersonatee aKeys (ambiguous or not). */
  private ees = new Set<string>()

  /** Load the persisted B->A map (hex-keyed). */
  loadJSON(map: Record<string, string> | undefined): void {
    if (map) {
      for (const [b, a] of Object.entries(map)) this.m.set(addrKey(b), checksumAddress(a))
    }
    this.rebuildInverse()
  }

  /** Merge seed pairs [B, A]; seed loses to existing runtime entries. */
  seed(pairs: Array<[Hex, Hex]>): void {
    for (const [b, a] of pairs) {
      const bk = addrKey(b)
      if (!this.m.has(bk)) this.m.set(bk, checksumAddress(a))
    }
    this.rebuildInverse()
  }

  private rebuildInverse(): void {
    const counts = new Map<string, number>()
    const first = new Map<string, Hex>()
    for (const [bk, a] of this.m) {
      const ak = addrKey(a)
      counts.set(ak, (counts.get(ak) ?? 0) + 1)
      if (!first.has(ak)) first.set(ak, checksumAddress(bk))
    }
    this.inv = new Map()
    this.ees = new Set()
    for (const [ak, n] of counts) {
      this.ees.add(ak)
      if (n === 1) this.inv.set(ak, first.get(ak)!)
    }
  }

  isEmpty(): boolean {
    return this.m.size === 0
  }

  /** Returns A if b maps to one, else null. */
  resolve(b: Hex): Hex | null {
    return this.m.get(addrKey(b)) ?? null
  }

  /** A if addr is an impersonator, else addr unchanged. */
  swap(addr: Hex): Hex {
    return this.m.get(addrKey(addr)) ?? addr
  }

  /** Unique B if A maps back unambiguously, else null. */
  resolveInverse(a: Hex): Hex | null {
    return this.inv.get(addrKey(a)) ?? null
  }

  /** Unique B if addr is an unambiguous impersonatee, else addr unchanged. */
  swapBack(addr: Hex): Hex {
    return this.inv.get(addrKey(addr)) ?? addr
  }

  isImpersonatee(addr: Hex): boolean {
    return this.ees.has(addrKey(addr))
  }

  /** Add B->A, replacing any entry for B. Rejects self-mapping. */
  set(b: Hex, a: Hex): void {
    if (addrEq(b, a)) throw new Error('impersonator and impersonatee must differ')
    this.m.set(addrKey(b), checksumAddress(a))
    this.rebuildInverse()
  }

  /** Drop the mapping for B. Returns false if B wasn't mapped. */
  remove(b: Hex): boolean {
    const ok = this.m.delete(addrKey(b))
    if (ok) this.rebuildInverse()
    return ok
  }

  /** A(checksum) -> [B(checksum)...], each list address-sorted. */
  inverted(): Record<string, Hex[]> {
    const out: Record<string, Hex[]> = {}
    for (const [bk, a] of this.m) {
      const ak = checksumAddress(a)
      ;(out[ak] ??= []).push(checksumAddress(bk))
    }
    for (const k of Object.keys(out)) out[k]!.sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1))
    return out
  }

  /** Persisted shape: { map: { B(checksum): A(checksum) } }, B-sorted. */
  serialize(): { map: Record<string, Hex> } {
    const keys = [...this.m.keys()].map((k) => checksumAddress(k)).sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1))
    const map: Record<string, Hex> = {}
    for (const bChk of keys) map[bChk] = this.m.get(addrKey(bChk))!
    return { map }
  }

  // --- byte-level rewriting ------------------------------------------------

  /** B->A over address-shaped 32-byte slots. */
  rewriteSlots(data: Uint8Array): [Uint8Array, boolean] {
    return rewriteSlotsWith(data, (a) => this.resolve(a))
  }

  /** A->B (unambiguous) over address-shaped 32-byte slots. */
  rewriteSlotsBack(data: Uint8Array): [Uint8Array, boolean] {
    return rewriteSlotsWith(data, (a) => this.resolveInverse(a))
  }

  /** B->A over calldata: keep the 4-byte selector, rewrite the argument tail. */
  rewriteCalldata(data: Uint8Array): [Uint8Array, boolean] {
    if (data.length < 4 + 32) return [data, false]
    const [tail, changed] = this.rewriteSlots(data.subarray(4))
    if (!changed) return [data, false]
    const out = new Uint8Array(4 + tail.length)
    out.set(data.subarray(0, 4), 0)
    out.set(tail, 4)
    return [out, true]
  }
}

/** A 32-byte chunk shaped like an address: 12 zero bytes + non-zero 20-byte tail. */
export function isAddressSlot(s: Uint8Array): boolean {
  if (s.length !== 32) return false
  for (let i = 0; i < 12; i++) if (s[i] !== 0) return false
  for (let i = 12; i < 32; i++) if (s[i] !== 0) return true
  return false
}

function rewriteSlotsWith(
  data: Uint8Array,
  resolve: (addr: Hex) => Hex | null,
): [Uint8Array, boolean] {
  let out: Uint8Array | null = null
  for (let off = 0; off + 32 <= data.length; off += 32) {
    const slot = data.subarray(off, off + 32)
    if (!isAddressSlot(slot)) continue
    const from = bytesToHex(slot.subarray(12, 32)) as Hex
    const to = resolve(from)
    if (!to) continue
    if (!out) out = data.slice()
    out.set(hexToBytes(toAddress(to)), off + 12)
  }
  return out ? [out, true] : [data, false]
}
