// Per-account sending kind, pinned once and persisted.
//
// With the replay guard on (the sandbox reuses the real chain id) every
// account is one of two kinds, decided by whether it holds native token on the
// real chain the first time the sandbox meets it:
//
//   'upstream'  funded on the real chain. Its raw transactions are refused by
//               the replay guard and it must send EIP-191 signed messages; a
//               dapp must never ask it for EIP-712 typed data either.
//   'sandbox'   empty on the real chain. Ordinary wallet flows apply.
//
// The verdict is pinned in DO storage on the account's first WRITE — the first
// sandbox transaction of its that lands (raw or signed message, reverted or
// not; a refused or failed send changes nothing and pins nothing) — and then
// holds for good, so the answer a dapp gets is stable from then on: a burner
// that is later topped up upstream stays 'sandbox', a real account that spends
// itself down stays 'upstream'. A read (fakereum_accountKind) never pins: until
// the account has transacted it reports the live upstream balance, marked
// unpinned. The replay guard uses the same verdict, so both sides always agree.

import type { Hex } from './lib/hex'
import { addrKey } from './lib/hex'

export type AccountKind = 'sandbox' | 'upstream'

export interface AccountKindStore {
  put(key: string, kind: AccountKind): Promise<void>
}

export class AccountKinds {
  private readonly kinds = new Map<string, AccountKind>()
  private readonly pending = new Map<string, Promise<AccountKind>>()

  constructor(
    private readonly upstreamBalance: (addr: Hex) => Promise<bigint>,
    private readonly store: AccountKindStore,
  ) {}

  /** Hydrate one persisted verdict (called per "account:kind:*" row at DO init). */
  load(key: string, kind: AccountKind): void {
    if (kind === 'sandbox' || kind === 'upstream') this.kinds.set(key, kind)
  }

  /** The pinned kind, or undefined when this account has never been classified. */
  peek(addr: Hex): AccountKind | undefined {
    return this.kinds.get(addrKey(addr))
  }

  /** What the account would be classified as right now, from its live upstream balance. */
  private async probe(addr: Hex): Promise<AccountKind> {
    return (await this.upstreamBalance(addr)) > 0n ? 'upstream' : 'sandbox'
  }

  /**
   * Read-only: the pinned kind, or — for an account that has not transacted
   * yet — the live classification, without pinning it.
   */
  async lookup(addr: Hex): Promise<{ kind: AccountKind; pinned: boolean }> {
    const known = this.kinds.get(addrKey(addr))
    if (known) return { kind: known, pinned: true }
    return { kind: await this.probe(addr), pinned: false }
  }

  /**
   * Pin the account's kind (a write landed). Pass the kind a lookup just
   * returned to avoid a second upstream read; otherwise the balance is probed
   * once. Idempotent; concurrent first pins share one read.
   */
  async pin(addr: Hex, probed?: AccountKind): Promise<AccountKind> {
    const key = addrKey(addr)
    const known = this.kinds.get(key)
    if (known) return known
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const p = (async () => {
      const kind = probed ?? (await this.probe(addr))
      this.kinds.set(key, kind)
      await this.store.put(key, kind)
      return kind
    })()
    this.pending.set(key, p)
    try {
      return await p
    } finally {
      this.pending.delete(key)
    }
  }
}
