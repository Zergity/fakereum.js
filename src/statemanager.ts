// ForkingStateManager: an EthereumJS v10 StateManagerInterface backed by the
// sticky Overlay layered over upstream@latest (via Fetcher). Replaces the
// hand-rolled synchronous vm.StateDB in state.go — here every read can `await`
// an upstream fetch on a cold miss, which is what makes a lazy fork possible in
// the Workers runtime.
//
// It also records, per touched address, the load-time (pre-tx) snapshot and the
// overlay-presence flags, so after execution we can emit the exact TxDiff
// (state_diff.go) that undo replays, and the WorkingChange set that Overlay
// commits.

import {
  Account,
  Address,
  createAccount,
  KECCAK256_NULL,
  bytesToHex as ejBytesToHex,
  equalsBytes,
} from '@ethereumjs/util'
import type { AccountFields, StateManagerInterface } from '@ethereumjs/common'
import type { Overlay, WorkingChange } from './overlay'
import type { StateReader } from './fetcher'
import type { AccountDiff, StorageChange, TxDiff } from './types'
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  toBigInt,
  toHash32Hex,
  toQuantity,
  type Hex,
} from './lib/hex'

type AcctVal = Account | undefined

function keyOf(addr: Address): string {
  return ejBytesToHex(addr.bytes).toLowerCase()
}
function slotKey(key: Uint8Array): string {
  return toHash32Hex(key)
}
/** Trim leading zero bytes (EthereumJS storage-value convention). */
function trimZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length && b[i] === 0) i++
  return b.subarray(i)
}
function isEmptyAccount(a: AcctVal): boolean {
  return !a || (a.nonce === 0n && a.balance === 0n && equalsBytes(a.codeHash, KECCAK256_NULL))
}

/** Pre-tx load snapshot of an account (immutable once captured). */
interface BaseSnapshot {
  account: AcctVal
  code: Uint8Array
  exists: boolean
  // overlay-presence at load time
  overlayExists: boolean
  overlayBalanceSet: boolean
  overlayNonceSet: boolean
  overlayCodeSet: boolean
  overlayStorageHad: Set<string>
}

interface WAccount {
  account: AcctVal // current working account (undefined = empty/non-existent)
  loaded: boolean
  code: Uint8Array | null // null = not yet loaded into working
  storage: Map<string, Uint8Array> // current working slot values (trimmed)
  selfDestructed: boolean
  // full-replace state override: unlisted slots read as 0 (no upstream fallthrough)
  storageReplaced: boolean
}

type Restore = () => void

export class ForkingStateManager implements StateManagerInterface {
  // immutable pre-tx base (lazily filled, never mutated by execution)
  private base = new Map<string, BaseSnapshot>()
  private baseStorage = new Map<string, Map<string, Uint8Array>>() // committed slot values
  // working layer
  private w = new Map<string, WAccount>()
  // journaled undo stack: each frame maps a change-key -> restore-to-baseline fn
  private journal: Array<Map<string, Restore>> = []

  // required by the interface
  readonly originalStorageCache: {
    get(address: Address, key: Uint8Array): Promise<Uint8Array>
    clear(): void
  }

  constructor(
    private readonly overlay: Overlay,
    // Fetcher in real runs; MissRecorder in speculative warm-up runs.
    private readonly fetcher: StateReader,
  ) {
    this.originalStorageCache = {
      get: (address: Address, key: Uint8Array) => this.committedStorage(address, key),
      clear: () => {},
    }
  }

  // --- journaling ---------------------------------------------------------

  private record(changeKey: string, restore: Restore): void {
    const frame = this.journal[this.journal.length - 1]
    if (!frame) return // no checkpoint open => mutation is permanent
    if (!frame.has(changeKey)) frame.set(changeKey, restore)
  }

  async checkpoint(): Promise<void> {
    this.journal.push(new Map())
  }

  async commit(): Promise<void> {
    const top = this.journal.pop()
    if (!top) return
    const parent = this.journal[this.journal.length - 1]
    if (!parent) return
    for (const [k, restore] of top) if (!parent.has(k)) parent.set(k, restore)
  }

  async revert(): Promise<void> {
    const top = this.journal.pop()
    if (!top) return
    for (const restore of top.values()) restore()
  }

  // --- base hydration (overlay -> upstream), captured once ----------------

  private async loadBase(key: string, addr: Address): Promise<BaseSnapshot> {
    let b = this.base.get(key)
    if (b) return b

    const ovl = this.overlay.get(key)
    let nonce = 0n
    let balance = 0n
    let code: Uint8Array = new Uint8Array(0)
    let exists = false

    const snap: BaseSnapshot = {
      account: undefined,
      code: new Uint8Array(0),
      exists: false,
      overlayExists: !!ovl,
      overlayBalanceSet: !!(ovl && ovl.balanceSet),
      overlayNonceSet: !!(ovl && ovl.nonceSet),
      overlayCodeSet: !!(ovl && ovl.codeSet),
      overlayStorageHad: new Set(ovl ? [...ovl.storage.keys()] : []),
    }

    const hexAddr = ejBytesToHex(addr.bytes) as Hex
    if (ovl && ovl.balanceSet) {
      balance = ovl.balance
      exists = true
    } else {
      balance = await this.fetcher.getBalance(hexAddr)
      if (balance !== 0n) exists = true
    }
    if (ovl && ovl.nonceSet) {
      nonce = ovl.nonce
      exists = true
    } else {
      nonce = await this.fetcher.getNonce(hexAddr)
      if (nonce !== 0n) exists = true
    }
    if (ovl && ovl.codeSet) {
      code = ovl.code
      if (code.length > 0) exists = true
    } else {
      code = await this.fetcher.getCode(hexAddr)
      if (code.length > 0) exists = true
    }

    const codeHash = code.length > 0 ? keccak256(code) : KECCAK256_NULL
    snap.account = exists ? createAccount({ nonce, balance, codeHash }) : undefined
    snap.code = code
    snap.exists = exists

    // seed committed storage from overlay (upstream slots fetched lazily)
    const bs = new Map<string, Uint8Array>()
    if (ovl) for (const [sk, v] of ovl.storage) bs.set(sk, trimZeros(hexToBytes(v)))
    this.baseStorage.set(key, bs)

    this.base.set(key, snap)
    return snap
  }

  private async ensureWorking(key: string, addr: Address): Promise<WAccount> {
    let wa = this.w.get(key)
    if (wa && wa.loaded) return wa
    const b = await this.loadBase(key, addr)
    wa = {
      account: b.account ? cloneAccount(b.account) : undefined,
      loaded: true,
      code: b.code,
      storage: new Map(),
      selfDestructed: false,
      storageReplaced: false,
    }
    this.w.set(key, wa)
    return wa
  }

  /** committed (pre-tx) value of a slot: base storage, then upstream on miss. */
  private async committedStorage(addr: Address, key: Uint8Array): Promise<Uint8Array> {
    const k = keyOf(addr)
    await this.loadBase(k, addr)
    const bs = this.baseStorage.get(k)!
    const sk = slotKey(key)
    const have = bs.get(sk)
    if (have !== undefined) return have
    const wa = this.w.get(k)
    if (wa && wa.storageReplaced) return new Uint8Array(0)
    const v = await this.fetcher.getStorageAt(ejBytesToHex(addr.bytes) as Hex, sk as Hex)
    const trimmed = trimZeros(hexToBytes(v))
    bs.set(sk, trimmed)
    return trimmed
  }

  // --- account methods ----------------------------------------------------

  async getAccount(address: Address): Promise<Account | undefined> {
    const wa = await this.ensureWorking(keyOf(address), address)
    return wa.account
  }

  async putAccount(address: Address, account?: Account): Promise<void> {
    const key = keyOf(address)
    const wa = await this.ensureWorking(key, address)
    const prev = wa.account
    this.record('acct:' + key, () => {
      wa.account = prev
    })
    wa.account = account ? cloneAccount(account) : undefined
  }

  async deleteAccount(address: Address): Promise<void> {
    const key = keyOf(address)
    const wa = await this.ensureWorking(key, address)
    const prevAcct = wa.account
    const prevSelf = wa.selfDestructed
    const prevStorage = wa.storage
    this.record('del:' + key, () => {
      wa.account = prevAcct
      wa.selfDestructed = prevSelf
      wa.storage = prevStorage
    })
    // A delete of a previously-existing account is a selfdestruct for diff purposes.
    const base = this.base.get(key)
    if (base && base.exists) wa.selfDestructed = true
    wa.account = undefined
    wa.storage = new Map()
  }

  async modifyAccountFields(address: Address, fields: AccountFields): Promise<void> {
    const key = keyOf(address)
    const wa = await this.ensureWorking(key, address)
    const prev = wa.account
    this.record('acct:' + key, () => {
      wa.account = prev
    })
    const cur = wa.account ?? createAccount({})
    const next = createAccount({
      nonce: fields.nonce ?? cur.nonce,
      balance: fields.balance ?? cur.balance,
      storageRoot: fields.storageRoot ?? cur.storageRoot,
      codeHash: fields.codeHash ?? cur.codeHash,
    })
    wa.account = next
  }

  // --- code ---------------------------------------------------------------

  async getCode(address: Address): Promise<Uint8Array> {
    const wa = await this.ensureWorking(keyOf(address), address)
    return wa.code ?? new Uint8Array(0)
  }

  async getCodeSize(address: Address): Promise<number> {
    return (await this.getCode(address)).length
  }

  async putCode(address: Address, value: Uint8Array): Promise<void> {
    const key = keyOf(address)
    const wa = await this.ensureWorking(key, address)
    const prevCode = wa.code
    const prevAcct = wa.account
    this.record('code:' + key, () => {
      wa.code = prevCode
      wa.account = prevAcct
    })
    wa.code = value
    const codeHash = value.length > 0 ? keccak256(value) : KECCAK256_NULL
    const cur = wa.account ?? createAccount({})
    wa.account = createAccount({
      nonce: cur.nonce,
      balance: cur.balance,
      storageRoot: cur.storageRoot,
      codeHash,
    })
  }

  // --- storage ------------------------------------------------------------

  async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
    const k = keyOf(address)
    const wa = await this.ensureWorking(k, address)
    const sk = slotKey(key)
    const dirty = wa.storage.get(sk)
    if (dirty !== undefined) return dirty
    return this.committedStorage(address, key)
  }

  async putStorage(address: Address, key: Uint8Array, value: Uint8Array): Promise<void> {
    const k = keyOf(address)
    const wa = await this.ensureWorking(k, address)
    const sk = slotKey(key)
    const had = wa.storage.has(sk)
    const prev = wa.storage.get(sk)
    this.record('stor:' + k + ':' + sk, () => {
      if (had) wa.storage.set(sk, prev!)
      else wa.storage.delete(sk)
    })
    wa.storage.set(sk, trimZeros(value))
  }

  async clearStorage(address: Address): Promise<void> {
    const k = keyOf(address)
    const wa = await this.ensureWorking(k, address)
    const prev = wa.storage
    this.record('clearstor:' + k, () => {
      wa.storage = prev
    })
    wa.storage = new Map()
  }

  // --- state root (sandbox never proves; stubs) ---------------------------

  async getStateRoot(): Promise<Uint8Array> {
    return new Uint8Array(32)
  }
  async setStateRoot(): Promise<void> {}
  async hasStateRoot(): Promise<boolean> {
    return true
  }

  clearCaches(): void {}

  shallowCopy(): StateManagerInterface {
    // A fresh view over the same overlay/fetcher. Used rarely (e.g. some VM
    // paths); execution always builds its own manager, so a clean copy is safe.
    return new ForkingStateManager(this.overlay, this.fetcher)
  }

  // --- state-override application (eth_call params[2]) --------------------

  /**
   * Apply geth-style state overrides directly into the working layer before a
   * read-only call (state_override.go applyTo). Bypasses the journal — these
   * are preconditions, not mutations.
   */
  async applyOverride(
    address: Address,
    o: {
      balance?: bigint
      nonce?: bigint
      code?: Uint8Array
      state?: Map<string, Uint8Array>
      stateDiff?: Map<string, Uint8Array>
    },
  ): Promise<void> {
    const key = keyOf(address)
    const wa = await this.ensureWorking(key, address)
    const cur = wa.account ?? createAccount({})
    let nonce = cur.nonce
    let balance = cur.balance
    let codeHash = cur.codeHash
    if (o.balance !== undefined) balance = o.balance
    if (o.nonce !== undefined) nonce = o.nonce
    if (o.code !== undefined) {
      wa.code = o.code
      codeHash = o.code.length > 0 ? keccak256(o.code) : KECCAK256_NULL
    }
    wa.account = createAccount({ nonce, balance, codeHash })
    if (o.state) {
      wa.storage = new Map()
      wa.storageReplaced = true
      for (const [sk, v] of o.state) wa.storage.set(sk, trimZeros(v))
    }
    if (o.stateDiff) {
      for (const [sk, v] of o.stateDiff) wa.storage.set(sk, trimZeros(v))
    }
  }

  // --- post-execution diff + commit set -----------------------------------

  /**
   * Produce the TxDiff (pre/post per changed account+slot, with overlay-presence
   * flags) AND the WorkingChange set to commit into the overlay. Call after the
   * tx run, before committing. Mirrors state_diff.go + state.go Commit.
   */
  collectChanges(): { diff: TxDiff; changes: WorkingChange[] } {
    const diff: TxDiff = { accounts: {} }
    const changes: WorkingChange[] = []

    for (const [key, wa] of this.w) {
      const base = this.base.get(key)
      if (!base) continue
      const preExists = base.exists
      const postExists = !!wa.account && !wa.selfDestructed && !isEmptyAccount(wa.account)

      const ad: AccountDiff = {
        preExists,
        postExists,
        preOverlayExists: base.overlayExists,
        balanceChanged: false,
        balancePreOverlaySet: base.overlayBalanceSet,
        nonceChanged: false,
        noncePreOverlaySet: base.overlayNonceSet,
        codeChanged: false,
        codePreOverlaySet: base.overlayCodeSet,
        storage: {},
        selfDestructed: wa.selfDestructed,
      }
      let changed = false
      const wc: WorkingChange = {
        addr: ('0x' + key.slice(2)) as Hex,
        selfDestructed: wa.selfDestructed,
        balanceSet: false,
        balance: 0n,
        nonceSet: false,
        nonce: 0n,
        codeSet: false,
        code: new Uint8Array(0),
        storage: new Map<string, Hex>(),
      }

      const preBal = base.account?.balance ?? 0n
      const preNonce = base.account?.nonce ?? 0n
      const preCode = base.code

      if (wa.selfDestructed) {
        changed = true
        // Eagerly capture pre values so undo can restore them.
        ad.balanceChanged = true
        ad.preBalance = toQuantity(preBal)
        ad.postBalance = toQuantity(wa.account?.balance ?? 0n)
        ad.nonceChanged = true
        ad.preNonce = toQuantity(preNonce)
        ad.postNonce = toQuantity(wa.account?.nonce ?? 0n)
        ad.codeChanged = true
        ad.preCode = bytesToHex(preCode)
        ad.postCode = '0x' as Hex
      } else {
        const postBal = wa.account?.balance ?? 0n
        const postNonce = wa.account?.nonce ?? 0n
        const postCode = wa.code ?? new Uint8Array(0)

        if (postBal !== preBal) {
          ad.balanceChanged = true
          ad.preBalance = toQuantity(preBal)
          ad.postBalance = toQuantity(postBal)
          wc.balanceSet = true
          wc.balance = postBal
          changed = true
        }
        if (postNonce !== preNonce) {
          ad.nonceChanged = true
          ad.preNonce = toQuantity(preNonce)
          ad.postNonce = toQuantity(postNonce)
          wc.nonceSet = true
          wc.nonce = postNonce
          changed = true
        }
        if (!equalsBytes(postCode, preCode)) {
          ad.codeChanged = true
          ad.preCode = bytesToHex(preCode)
          ad.postCode = bytesToHex(postCode)
          wc.codeSet = true
          wc.code = postCode
          changed = true
        }
      }

      // storage: any working slot whose value differs from committed base.
      const bs = this.baseStorage.get(key) ?? new Map()
      for (const [sk, post] of wa.storage) {
        const pre = bs.get(sk) ?? new Uint8Array(0)
        if (equalsBytes(post, pre)) continue
        const sc: StorageChange = {
          pre: toHash32Hex(bytesToHex(pre)),
          post: toHash32Hex(bytesToHex(post)),
          preOverlaySet: base.overlayStorageHad.has(sk),
        }
        ad.storage[sk] = sc
        wc.storage.set(sk, toHash32Hex(bytesToHex(post)))
        changed = true
      }

      // Account creation (didn't exist, now exists) is a change even if fields are zero.
      if (!preExists && postExists && !wa.selfDestructed) changed = true

      if (changed) {
        diff.accounts[key] = ad
        changes.push(wc)
      }
    }

    return { diff, changes }
  }
}

function cloneAccount(a: Account): Account {
  return createAccount({
    nonce: a.nonce,
    balance: a.balance,
    storageRoot: a.storageRoot,
    codeHash: a.codeHash,
  })
}
