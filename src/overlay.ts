// The sticky sandbox overlay: post-state writes that survive across requests.
// In-memory mirror of DO storage (keys "overlay:<addrKey>"). Mutation methods
// return the addrKeys that changed/were deleted so the Durable Object can
// persist incrementally (instead of rewriting the whole blob per tx).
//
// Ports state.go (Overlay), state_diff.go semantics, undo.go (ApplyReverseDiff)
// and clear_sandbox.go (ClearAccounts).

import type {
  AccountDiff,
  GenesisAlloc,
  OverlayAccount,
  StateOverrideAccount,
  StateOverrides,
  TxDiff,
} from './types'
import {
  addrKey,
  bytesToHex,
  checksumAddress,
  hexToBytes,
  toBigInt,
  toHash32Hex,
  toQuantity,
  type Hex,
} from './lib/hex'

/** Internal rich account model. A field is "set" iff its *Set flag is true. */
interface OAccount {
  balanceSet: boolean
  balance: bigint
  nonceSet: boolean
  nonce: bigint
  codeSet: boolean
  code: Uint8Array
  storage: Map<string, Hex> // slot(0x-64) -> value(0x-64)
}

/**
 * The post-execution write set the StateManager hands back for a tx/call. Only
 * touched accounts; *Set flags mark which fields were actually written.
 */
export interface WorkingChange {
  addr: Hex
  selfDestructed: boolean
  balanceSet: boolean
  balance: bigint
  nonceSet: boolean
  nonce: bigint
  codeSet: boolean
  code: Uint8Array
  storage: Map<string, Hex>
}

/** Set of addrKeys touched by a mutation, split by whether the entry survives. */
export interface OverlayDelta {
  updated: Set<string>
  deleted: Set<string>
}

function emptyAccount(): OAccount {
  return {
    balanceSet: false,
    balance: 0n,
    nonceSet: false,
    nonce: 0n,
    codeSet: false,
    code: new Uint8Array(0),
    storage: new Map(),
  }
}

export class Overlay {
  private accounts = new Map<string, OAccount>()

  // --- load / serialize (DO persistence) ---------------------------------

  /** Hydrate one account from its persisted JSON view (called at DO init). */
  load(key: string, j: OverlayAccount): void {
    const a = emptyAccount()
    if (j.balance !== undefined) {
      a.balance = toBigInt(j.balance)
      a.balanceSet = true
    }
    if (j.nonce !== undefined) {
      a.nonce = toBigInt(j.nonce)
      a.nonceSet = true
    }
    if (j.code !== undefined) {
      a.code = hexToBytes(j.code)
      a.codeSet = true
    }
    if (j.storage) {
      for (const [slot, val] of Object.entries(j.storage)) {
        a.storage.set(toHash32Hex(slot), toHash32Hex(val))
      }
    }
    this.accounts.set(key, a)
  }

  /** JSON view of an account for persistence; null if no record. */
  serialize(key: string): OverlayAccount | null {
    const a = this.accounts.get(key)
    if (!a) return null
    const out: OverlayAccount = {}
    if (a.balanceSet) out.balance = toQuantity(a.balance)
    if (a.nonceSet) out.nonce = toQuantity(a.nonce)
    if (a.codeSet) out.code = bytesToHex(a.code)
    if (a.storage.size > 0) {
      out.storage = {}
      for (const [slot, val] of a.storage) out.storage[slot] = val
    }
    return out
  }

  // --- reads --------------------------------------------------------------

  get(key: string): OAccount | undefined {
    return this.accounts.get(key)
  }

  has(addr: Hex): boolean {
    return this.accounts.has(addrKey(addr))
  }

  keys(): string[] {
    return [...this.accounts.keys()]
  }

  /** JSON view for the address explorer; null if no overlay record. */
  viewAccount(addr: Hex): OverlayAccount | null {
    return this.serialize(addrKey(addr))
  }

  /** [{address, acct}] view for the /accounts list. */
  entriesView(): Array<{ address: Hex; acct: OverlayAccount }> {
    const out: Array<{ address: Hex; acct: OverlayAccount }> = []
    for (const key of this.accounts.keys()) {
      const acct = this.serialize(key)
      if (acct) out.push({ address: checksumAddress(key), acct })
    }
    return out
  }

  // --- stateOverride encoding (eth_call default mode) --------------------

  /**
   * The overlay encoded as geth eth_call `stateOverrides` (params[2]). Address
   * keys are EIP-55 checksummed; storage goes under `stateDiff` (patch, not
   * full replace) so untouched slots still fall through to upstream. Mirrors
   * state.go AsStateOverrides. Only accounts with a set field are emitted.
   */
  asStateOverrides(): StateOverrides {
    const out: StateOverrides = {}
    for (const [key, a] of this.accounts) {
      const entry: StateOverrideAccount = {}
      let set = false
      if (a.balanceSet) {
        entry.balance = toQuantity(a.balance)
        set = true
      }
      if (a.nonceSet) {
        entry.nonce = toQuantity(a.nonce)
        set = true
      }
      if (a.codeSet) {
        entry.code = bytesToHex(a.code)
        set = true
      }
      if (a.storage.size > 0) {
        entry.stateDiff = {}
        for (const [slot, val] of a.storage) entry.stateDiff[slot] = val
        set = true
      }
      if (set) out[checksumAddress(key)] = entry
    }
    return out
  }

  // --- mutations ----------------------------------------------------------

  /** Apply a tx/call working set into the sticky overlay (state.go Commit). */
  commit(changes: WorkingChange[]): OverlayDelta {
    const delta: OverlayDelta = { updated: new Set(), deleted: new Set() }
    for (const w of changes) {
      const key = addrKey(w.addr)
      if (w.selfDestructed) {
        if (this.accounts.delete(key)) delta.deleted.add(key)
        continue
      }
      let a = this.accounts.get(key)
      if (!a) {
        a = emptyAccount()
        this.accounts.set(key, a)
      }
      let dirty = false
      if (w.balanceSet) {
        a.balance = w.balance
        a.balanceSet = true
        dirty = true
      }
      if (w.nonceSet) {
        a.nonce = w.nonce
        a.nonceSet = true
        dirty = true
      }
      if (w.codeSet) {
        a.code = w.code
        a.codeSet = true
        dirty = true
      }
      for (const [slot, val] of w.storage) {
        a.storage.set(slot, val)
        dirty = true
      }
      if (dirty) {
        delta.updated.add(key)
        delta.deleted.delete(key)
      }
    }
    return delta
  }

  /**
   * Rewind the overlay to a tx's pre-state using its diff (undo.go
   * ApplyReverseDiff). PreOverlay* flags decide restore-Pre vs delete-entry.
   */
  applyReverseDiff(d: TxDiff | null | undefined): OverlayDelta {
    const delta: OverlayDelta = { updated: new Set(), deleted: new Set() }
    if (!d || Object.keys(d.accounts).length === 0) return delta

    for (const [key, ad] of Object.entries(d.accounts)) {
      if (ad.selfDestructed) {
        // Commit deleted the entry; recreate from the eagerly-captured Pre snapshot.
        let a = this.accounts.get(key)
        if (!a) {
          a = emptyAccount()
          this.accounts.set(key, a)
        }
        if (ad.balancePreOverlaySet) {
          a.balance = toBigInt(ad.preBalance ?? '0x0')
          a.balanceSet = true
        } else {
          a.balanceSet = false
          a.balance = 0n
        }
        if (ad.noncePreOverlaySet) {
          a.nonce = toBigInt(ad.preNonce ?? '0x0')
          a.nonceSet = true
        } else {
          a.nonceSet = false
          a.nonce = 0n
        }
        if (ad.codePreOverlaySet) {
          a.code = hexToBytes(ad.preCode ?? '0x')
          a.codeSet = true
        } else {
          a.codeSet = false
          a.code = new Uint8Array(0)
        }
        for (const [slot, sc] of Object.entries(ad.storage)) {
          if (sc.preOverlaySet) a.storage.set(slot, sc.pre)
        }
        delta.updated.add(key)
        continue
      }

      const a = this.accounts.get(key)
      if (!a) continue // tx made no overlay-visible change

      if (ad.balanceChanged) {
        if (ad.balancePreOverlaySet) {
          a.balance = toBigInt(ad.preBalance ?? '0x0')
          a.balanceSet = true
        } else {
          a.balanceSet = false
          a.balance = 0n
        }
      }
      if (ad.nonceChanged) {
        if (ad.noncePreOverlaySet) {
          a.nonce = toBigInt(ad.preNonce ?? '0x0')
          a.nonceSet = true
        } else {
          a.nonceSet = false
          a.nonce = 0n
        }
      }
      if (ad.codeChanged) {
        if (ad.codePreOverlaySet) {
          a.code = hexToBytes(ad.preCode ?? '0x')
          a.codeSet = true
        } else {
          a.codeSet = false
          a.code = new Uint8Array(0)
        }
      }
      for (const [slot, sc] of Object.entries(ad.storage)) {
        if (sc.preOverlaySet) a.storage.set(slot, sc.pre)
        else a.storage.delete(slot)
      }

      // Prune an account that no longer holds any overlay record.
      if (
        !a.balanceSet &&
        !a.nonceSet &&
        !a.codeSet &&
        a.storage.size === 0 &&
        !ad.preOverlayExists
      ) {
        this.accounts.delete(key)
        delta.deleted.add(key)
      } else {
        delta.updated.add(key)
      }
    }
    return delta
  }

  /** Fill-only genesis seed (genesis.go ApplyGenesis). Returns #accounts touched. */
  applyGenesis(g: GenesisAlloc | null): { count: number; delta: OverlayDelta } {
    const delta: OverlayDelta = { updated: new Set(), deleted: new Set() }
    if (!g || !g.alloc) return { count: 0, delta }
    let count = 0
    for (const [addrHex, ga] of Object.entries(g.alloc)) {
      const key = addrKey(addrHex)
      let a = this.accounts.get(key)
      if (!a) {
        a = emptyAccount()
        this.accounts.set(key, a)
      }
      let touched = false
      if (ga.balance !== undefined && !a.balanceSet) {
        a.balance = toBigInt(ga.balance)
        a.balanceSet = true
        touched = true
      }
      if (ga.nonce !== undefined && !a.nonceSet) {
        a.nonce = toBigInt(ga.nonce)
        a.nonceSet = true
        touched = true
      }
      if (ga.code !== undefined && !a.codeSet) {
        a.code = hexToBytes(ga.code)
        a.codeSet = true
        touched = true
      }
      if (ga.storage) {
        for (const [slot, val] of Object.entries(ga.storage)) {
          const sk = toHash32Hex(slot)
          if (!a.storage.has(sk)) {
            a.storage.set(sk, toHash32Hex(val))
            touched = true
          }
        }
      }
      if (touched) {
        delta.updated.add(key)
        count++
      } else if (a.storage.size === 0 && !a.balanceSet && !a.nonceSet && !a.codeSet) {
        // we created an empty shell for an alloc that added nothing new
        this.accounts.delete(key)
      }
    }
    return { count, delta }
  }

  /**
   * Admin override: replace an account's code, leaving balance/nonce/storage
   * untouched. Works uniformly for upstream contracts (whose real code is
   * otherwise fetched upstream) and sandbox-deployed contracts (whose code
   * already lives here) — every code read path consults the overlay first.
   * Passing empty code makes the address report as codeless; to restore an
   * upstream contract's original code, clear the account instead.
   */
  setCode(addr: Hex, code: Uint8Array): OverlayDelta {
    const key = addrKey(addr)
    let a = this.accounts.get(key)
    if (!a) {
      a = emptyAccount()
      this.accounts.set(key, a)
    }
    a.code = code
    a.codeSet = true
    return { updated: new Set([key]), deleted: new Set() }
  }

  /** Delete every account matching the predicate (clear_sandbox.go). */
  clearAccounts(shouldClear: (addr: Hex) => boolean): OverlayDelta {
    const delta: OverlayDelta = { updated: new Set(), deleted: new Set() }
    for (const key of [...this.accounts.keys()]) {
      if (shouldClear(checksumAddress(key))) {
        this.accounts.delete(key)
        delta.deleted.add(key)
      }
    }
    return delta
  }
}
