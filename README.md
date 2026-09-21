# Fakereum

A forked-EVM sandbox that fronts any EVM JSON-RPC endpoint, running on
**Cloudflare Workers** (Free plan included).

Reads fall through to the real chain at its current tip. Transactions execute
**locally** against a sticky layer of sandbox writes stacked on top of that
live state, and their diffs stick — across requests, across restarts. The
merged result is served over both Ethereum JSON-RPC and an
Etherscan-v2-compatible API, so a dapp points at one base URL and sees real
history with its own sandbox writes folded in. Nothing ever reaches the real
chain.

Transactions are normally sent as **EIP-191 signed messages**: the wallet signs
a short readable text with `personal_sign` and the sandbox executes a real
transaction from the recovered signer. That signature is worthless on any
chain, so it is safe to sign from an account holding real funds, and the wallet
never has to leave the network it is on. Raw `eth_sendRawTransaction` is
accepted too, for accounts the [replay guard](#replay-guard-and-account-kinds)
lets through.

```
dapp / wallet ──▶ https://<sandbox>/rpc      JSON-RPC (+ WebSocket)
                  https://<sandbox>/api      Etherscan v2 (getLogs merged)
                  https://<sandbox>/         explorer + landing page
```

## What it does

| surface | source | semantics |
|---|---|---|
| `balance` / `nonce` / `code` | overlay → upstream | reads fall through on a miss; sandbox writes are sticky |
| contract storage (`SLOAD`, `eth_getStorageAt`) | overlay → upstream | same fall-through, per slot |
| `eth_call` / `eth_estimateGas` | overlay + upstream | default: forwarded upstream with the overlay packed as `stateOverrides` (one round-trip); opt-in local-EVM mode. Caller-supplied state overrides honored in both |
| `fakereum_sendTransaction` | local EVM | executes an EIP-191 signed message against the overlay plus live upstream state, and commits the diff to the overlay — the default send path |
| `eth_sendRawTransaction` | local EVM | the same, from signed RLP, subject to the replay guard |
| `eth_getTransactionByHash` / `…Receipt` | sandbox first, then upstream | sandbox txs answer locally; everything else proxies |
| `eth_getLogs` | upstream + sandbox merged | upstream range/rate-limit errors are surfaced, not swallowed |
| `/api?module=logs&action=getLogs` | upstream + sandbox merged, sorted | Etherscan OR-cluster topic semantics; answers sandbox-only when the explorer is down |
| `eth_getBlockByNumber` at the head | upstream, clock corrected | timestamp moved to the sandbox head clock |
| everything else | upstream | passthrough with failover |

## Sandboxes

One deployment per upstream chain, each on its own base URL, each serving
`/rpc`, `/api` + `/v2/api`, and the explorer at `/` (`/txs`, `/accounts`,
`/import`, `/admin`):

| fork | base URL | chain id | currency | upstream explorer |
|---|---|---|---|---|
| Fake Arbitrum One | `https://fakereum-42161.derion.io` | `42161` | FETH | Etherscan v2 |
| Fake Robinhood Chain | `https://fakereum-4663.derion.io` | `4663` | FETH | Blockscout PRO gateway |
| Fake Hemi | `https://fakereum-43111.derion.io` | `43111` | FETH | Blockscout (`explorer.hemi.xyz`) |

Each reuses the real chain's id so wallets need no network re-add — which is
exactly why the [replay guard](#replay-guard-and-account-kinds) is on for all of
them. Read that section before sending anything. Examples below use the
Arbitrum fork; nothing in this document is specific to it.

## Sending a transaction

Three calls, all plain HTTP POSTs to the sandbox's `/rpc`. Wallets refuse to
relay `fakereum_*` methods, so the dapp talks to the sandbox directly and uses
the wallet only to sign:

```js
const SANDBOX = 'https://fakereum-42161.derion.io/rpc'
const rpc = async (method, params) => {
  const r = await fetch(SANDBOX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())
  if (r.error) throw new Error(r.error.message)
  return r.result
}

// 1. ask the sandbox for the exact text to sign, and the nonce it was built with
const { message, nonce } = await rpc('fakereum_transactionMessage',
  [{ from: account, to, value, data }])

// 2. the wallet signs it — on whatever network it happens to be on
const signature = await window.ethereum.request({
  method: 'personal_sign', params: [message, account] })

// 3. hand it back: the transaction executes on arrival and the hash returns
const hash = await rpc('fakereum_sendTransaction', [{ to, value, data, nonce, signature }])
```

What the user sees in the wallet prompt:

```
Fakereum Tx #13 on Arbitrum One
To: 0xAb58…eC9B
Value: 0.001
Data: 0xa9059cbb and 64 bytes with hash 0x…
```

From there on it is an ordinary transaction: a real hash, a receipt on
`eth_getTransactionReceipt`, logs in `eth_getLogs`, a page at `/tx/<hash>`.

The SDK collapses all of it into a provider your existing stack already knows
how to hold:

```ts
import { createSandboxProvider } from 'fakereum-sdk'

const provider = createSandboxProvider({ sandbox: SANDBOX, wallet: window.ethereum })
const signer = await new ethers.BrowserProvider(provider).getSigner()
await signer.sendTransaction({ to, value })     // travels as a signed message
```

Details — the message format, gas and fee defaults, contract creation, nonce
handling — are in [Transactions](#transactions). Raw
`eth_sendRawTransaction` works too, within the limits of the
[replay guard](#replay-guard-and-account-kinds).

## The overlay

```
       ┌────────────────┐  eth_call · eth_getBalance · eth_getStorageAt · …
       │      dapp      │ ────────────────────────────────┐
       └────────────────┘                                 │
                                                          ▼
                                    ┌────────────────────────────────────────┐
       ┌────────────────┐           │             Fakereum                   │
       │  sandbox tx    │ ─signed──▶│  fakereum_sendTransaction  (EIP-191)   │
       │  (user wallet) │           │  eth_sendRawTransaction    (raw RLP)   │
       └────────────────┘           │                │                       │
                                    │                ▼                       │
                                    │   ┌──────────────────────────┐         │
                                    │   │  per-call layered state  │         │
                                    │   ├──────────────────────────┤         │
                                    │   │  overlay (sticky)        │ ◀────── │ committed tx
                                    │   │   balance · nonce ·      │         │ diffs land
                                    │   │   code · storage[]       │         │ here, persisted
                                    │   └───────────┬──────────────┘         │
                                    │               │ miss                   │
                                    │               ▼                        │
                                    │   ┌──────────────────────────┐         │
                                    │   │  fetcher → upstream      │         │
                                    │   │  getBalance · getCode ·  │         │
                                    │   │  getTransactionCount ·   │         │
                                    │   │  getStorageAt (batched,  │         │
                                    │   │  TTL-cached)             │         │
                                    │   └───────────┬──────────────┘         │
                                    └───────────────┼────────────────────────┘
                                                    ▼
                                        ┌──────────────────────────┐
                                        │  real chain @ latest     │
                                        └──────────────────────────┘
```

- **Reads** consult the overlay first; a miss falls through to the upstream
  chain, read at the JSON-RPC `latest` block — written `upstream@latest` from
  here on. Anything the sandbox has touched returns the sandbox value,
  everything else mirrors the live chain.
- **Writes** run the EVM against the overlay stacked on `upstream@latest`, and
  commit the resulting diff to the overlay only.
- **Per-call re-fork.** Every request resolves upstream values at its own moment
  in time. There is no pinned fork block, so oracle prices, pool reserves and
  freshly deployed contracts are always current.
- The overlay stores **post-state**, not deltas. See
  [state conflicts](#state-conflicts) for what that implies when the real chain
  later moves a slot the sandbox already wrote.

### Not a pinned fork

```
 time ─▶            t0          t1          t2          t3          t4          t5
                    │           │           │           │           │           │
 real chain    ━━━━ N  ━━━━━━▶ N+1 ━━━━━▶ N+2 ━━━━━▶ N+3 ━━━━━▶ N+4 ━━━━━▶ N+5 ━━━▶
                    │                                                              (live)
               fork │
                    ▼
 pinned fork   ┄┄┄┄ N ┄┄┄┄┄┄━▶ N+1'━━━━━▶ N+2'━━━━━▶ N+3'━━━━━▶ N+4'━━━━━▶ N+5'━━━▶
                                ▲          ▲                      ▲                (private chain;
                                tx @ t1    tx @ t2                tx @ t4          real N+1..N+5
                                                                                   never visible)

 fakereum      ━━━━ N  ━━━━━━▶ N+1 ━━━━━▶ N+2 ━━━━━▶ N+3 ━━━━━▶ N+4 ━━━━━▶ N+5 ━━━▶
                                │          │                      │               (mirrors the real
                                tx @ t1    tx @ t2                tx @ t4         chain; no fork point)
                             ┌──┴────┐ ┌───┴───┐              ┌───┴───┐
                             │OVERLAY│ │OVERLAY│              │OVERLAY│           (writes stick;
                             │ diff  │ │ diff  │              │ diff  │            real chain is
                             └───────┘ └───────┘              └───────┘            never mutated)
                                ▲          ▲                      ▲
                                └──────────┴──────────────────────┘
                                  read-through to the real chain for
                                  every slot the overlay hasn't touched
```

A local fork (anvil, hardhat) snapshots at a block and diverges into a private
timeline; fakereum rides on top of the live one. Pick a local fork when you
want a reproducible snapshot for tests. Pick this when you want live
conditions, a shared persistent sandbox, a chain id that matches production,
and merged real + sandbox history over the same Etherscan API a dapp already
calls.

## Architecture

```
            ┌───────────────── Cloudflare edge ──────────────────┐
 dapp ─────▶│  Pages project  fakereum-<chainid>                 │
 wallet     │    public/_worker.js — thin forwarder              │
            │  Worker  fakereum-<chainid>-rpc                    │
            │    src/index.ts — thin forwarder                   │
            │                │ stub.fetch(request)               │
            │                ▼                                   │
            │  EvmSandbox — Durable Object (SQLite-backed)       │
            │    overlay · sandbox txs & logs · account kinds ·  │
            │    imports · impersonators · EVM executor ·        │
            │    upstream cache · rate limiter · client sockets  │
            └────────────────┼───────────────────────────────────┘
                             │ fetch()  JSON-RPC + explorer API
                             ▼
                  upstream RPC(s), upstream explorer
```

Both front doors — the Worker's own `*.workers.dev` host and the Pages custom
domain — resolve the Durable Object by the same fixed name (`fakereum`), so
they address one instance and share all state. Pages cannot host a Durable
Object, so its `_worker.js` binds the class cross-script from the companion
Worker. One deployment per upstream chain, side by side as wrangler
environments.

### Why a Durable Object runs the EVM

On the Free plan a plain Worker request gets **10 ms of CPU** — nowhere near
enough for EVM execution. **Durable Objects get a 30 s CPU budget on every
plan, Free included.** So the front Worker is deliberately thin: it forwards
every request into the `EvmSandbox` Durable Object, which owns all state and
runs the EVM. Time spent `await`ing upstream `fetch()` is I/O, not CPU, so lazy
state reads don't burn the budget.

The DO is single-threaded, which also makes it the natural place for things
that need exactness: the per-IP rate limiter sees every request, and state
mutations need no locking.

### The EVM stack

The executor drives **EthereumJS v10** (`@ethereumjs/vm`), pinned to the
**Cancun** hardfork, with the sandbox chain id bound for signature recovery.
Behind it sits a custom `StateManager` whose reads are **async**: a cold
account or slot is fetched from upstream mid-execution. That is what makes a
lazy fork possible in a runtime with no synchronous I/O.

Each executed transaction:

1. **Prefetch.** The call is simulated upstream via `eth_createAccessList`
   (with the overlay attached as state overrides and the sender's balance
   forced high), and every listed account and slot is batch-fetched into the
   cache. One subrequest for the list, one per 100 reads.
2. **Speculative warm-up.** The tx is then run on a throwaway VM whose reads
   come from the cache only — anything cold answers zero and is recorded. The
   whole recorded set is batch-fetched and the round repeats until a run
   completes fully warm (typically 1–3 rounds, capped at 6). A zero guess can
   steer a round down a wrong branch, but the next round holds the true value
   and goes deeper, so the set grows monotonically.
3. **Execution.** The real run happens against the layered state. Whatever the
   warm-up missed still falls through to a lazy per-read fetch, which remains
   the source of correctness.
4. **Diff capture.** The state manager records, per touched address, the
   pre-execution snapshot and which fields the overlay already held, so the
   exact per-tx diff can be emitted — the one [undo](#undo) replays in reverse.
5. **Commit.** The write set lands in the overlay, the receipt and logs go into
   the sandbox store, both are persisted, the signer's
   [account kind](#replay-guard-and-account-kinds) is pinned, and WebSocket
   subscribers are pushed to.

Two more details of execution worth knowing:

- **baseFee lowering.** If the signed `maxFeePerGas` is below the upstream
  baseFee, the synthetic block's baseFee is lowered to that cap so the tx still
  lands instead of failing fee validation.
- **ecrecover swap.** When impersonators are configured, the `0x01` precompile
  is replaced by one that remaps a recovered impersonator `B` to its
  impersonatee `A`, so on-chain signature checks (Permit, EIP-1271, ERC-4337)
  agree with `msg.sender`.

The **deploy mechanism** of every contract created inside a tx (`tx`, `create`,
`create2`) is captured live off the EVM message stream, not inferred — the diff
only shows that code appeared. Older stored txs without that annotation are
reconstructed from the diff by trying nonce-based address derivation for every
deployer in it.

### Talking to upstream

One HTTP JSON-RPC client fronts the comma-separated `UPSTREAM_RPC` list.

- **Failover.** URLs are tried in order. A transport error, HTTP 401/403/429 or
  5xx moves to the next and **benches** the failing one for 30 s. A failed pass
  over the whole list is retried twice with 250 ms / 750 ms backoff, but only
  when the failure looked transient.
- **Provider refusals that arrive as HTTP 200.** Several public endpoints answer
  a quota refusal, a routing failure (`code 12`, "can't route your request") or
  a disabled method (`-32601`, or publicnode's `-32701` for an address-less
  `eth_getLogs`) with a normal JSON-RPC error body. Those are detected and
  failed over rather than returned as the chain's answer. A method refusal is
  remembered per (URL, method) — skipping it later saves a wasted subrequest —
  and cleared on the first success. Only if *every* URL refuses is the refusal
  returned.
- **Batching.** Cold reads are packed into batch POSTs of up to 100 calls. The
  Workers subrequest cap counts HTTP requests, not RPC calls, which is how a
  lazy fork stays inside the budget. An endpoint that answers a batch with a
  bare object fails over.
- **Monotonic head guard.** A chain's head only grows, so the highest block
  number any URL has reported is a lower bound the real head always satisfies.
  A head read (`eth_blockNumber`, or `eth_getBlockByNumber` at `latest` /
  `pending`) answering more than **64 blocks** below that bound came from a
  backend that stopped following the chain — it fails over and benches the URL
  for 30 s. The margin absorbs honest skew between healthy nodes (64 blocks is
  ~7 s on a 9 block/s Orbit chain). Only when every configured URL answers
  below the bound is the bound itself taken to be wrong, and the best answer
  re-anchors it. Other methods carry no head to judge, so `eth_call` is
  protected only indirectly, through the bench.

### Caching

| what | where | lifetime |
|---|---|---|
| balances, nonces, storage slots, gas price, chain id, latest block | in-memory map inside the DO | `CACHE_TTL` (default 12 s) |
| contract code | DO storage (`codecache:<addr>`), plus the memory tier | 24 h |
| everything on the request path (`eth_getLogs`, passthrough) | not cached | — |

Code gets the durable tier because it is large, nearly immutable, and DO
storage reads don't count as subrequests — so a DO that was evicted comes back
without re-fetching every contract it knows. The replay guard's balance check
deliberately bypasses the cache so a stale dapp poll can't feed it.

### Persistence

Everything lives in the Durable Object's SQLite-backed storage, written
incrementally (only the accounts a mutation touched):

| key | holds |
|---|---|
| `overlay:<address>` | one account's sticky balance / nonce / code / storage |
| `sandbox:tx:<hash>` | an executed tx: receipt fields, logs, full state diff, raw bytes |
| `sandbox:meta` | the sequence and log-index counters |
| `account:kind:<address>` | the pinned `upstream` / `sandbox` verdict |
| `import:<address>` | the one cross-chain import that account has made |
| `impersonators` | the impersonator → impersonatee map |
| `codecache:<address>` | cached upstream bytecode |
| `meta:genesisApplied` | genesis-seed idempotency flag |

The DO hydrates all of it before serving a request, and re-hydrates whenever
it wakes from eviction.

## Setup

Needs Node 20+ and a Cloudflare account; the Free plan is enough.

```sh
npm install
npm run typecheck                  # tsc --noEmit
npm test                           # vitest
npm run dev                        # wrangler dev, config from .dev.vars
```

Each upstream chain is its own deployment, kept side by side:

- `wrangler.toml` `[env.<chainid>]` — the Worker name and its `[vars]`
- `pages/<chainid>/wrangler.toml` — that chain's public Pages front door
- `.prod.vars.<chainid>` (gitignored) — its secrets; see `.prod.vars.example`

```sh
npm run deploy:secrets -- 42161    # first deploy of a chain: code + secrets
npm run deploy -- 42161            # later deploys (secrets are preserved)
npm run deploy:pages -- 42161      # the public front door
npm run build                      # wrangler deploy --dry-run: measure the bundle
```

Deploy the Worker before the Pages project — the Pages forwarder binds the
Durable Object class cross-script, so the class has to exist first. A bare
`wrangler deploy` without `--env` would create a stray top-level worker; the
top-level config exists only so `wrangler dev` and `npm run build` work without
picking an environment.

For local development, copy `.dev.vars.example` to `.dev.vars`.

## Configuration

Everything is a `wrangler.toml` `[vars]` entry, except the explorer key which
is a secret. Secrets override `[vars]` of the same name and survive plain
deploys — so keep `ADMINS`, `GENESIS`, `CORS_ORIGINS` and `ETHERSCAN_API_KEY`
out of committed `[vars]`, or the next deploy clobbers them.

| var | meaning | default |
|---|---|---|
| `UPSTREAM_RPC` | upstream JSON-RPC URL(s), comma-separated for failover (`ws(s)://` is rewritten to `http(s)://`) | `https://ethereum-rpc.publicnode.com` |
| `UPSTREAM_ETHERSCAN` | upstream explorer base: Etherscan v2, a single-chain Blockscout, or Blockscout's multichain PRO gateway | `https://api.etherscan.io/v2/api` |
| `UPSTREAM_ETHERSCAN_STYLE` | `etherscan` or `blockscout`; unset sniffs it from the URL (`blockscout` ⇒ decimal `getLogs` blocks + the `chain_id` param) | sniffed |
| `ETHERSCAN_API_KEY` *(secret)* | comma-separated keys, round-robin. On an Etherscan upstream it is internal-only and callers bring their own `apikey`; on Blockscout it is also the fallback key for proxied `/api` traffic, since the PRO gateway refuses anonymous requests (HTTP 402) | (none) |
| `CHAIN_ID` | sandbox chain id; `0` derives `420<upstreamId>` (upstream 42161 → 42042161) | `0` |
| `SYMBOL` / `NETWORK_NAME` | native symbol / network name | `F<sym>` / `Fake <name>` |
| `ETH_CALL_STORAGE_MODE` | `stateOverride` (Free-safe) or `getStorageAt` (local EVM) | `stateOverride` |
| `CACHE_TTL` | upstream read cache TTL, seconds | `12` |
| `REJECT_UPSTREAM_SIGNERS` | replay guard: `auto` / `true` / `false` | `auto` |
| `BALANCE_MULTIPLIER` | an account with no sandbox balance yet shows upstream × this; `1` turns it off | `1000` |
| `ADMINS` | comma-separated admin addresses; enables impersonation, clear, set-code | (none) |
| `IMPERSONATE` | seed mappings `B:A,B2:A2` (impersonator:impersonatee) | (none) |
| `CORS_ORIGINS` | comma-separated exact-match allowlist; empty = `*` | `*` |
| `RATE_LIMIT_RPS` | per-IP requests/second; `<= 0` disables | `0` |
| `RATE_LIMIT_EXEMPT` | comma-separated IPs/CIDRs (v4 or v6) that bypass the limit | (none) |
| `GENESIS` | inline geth-style `{"alloc":{…}}` JSON | (none) |

The sandbox chain id, the symbol and the network name are resolved once, on the
first request, from the upstream's `eth_chainId`.

## HTTP routes

| route | purpose |
|---|---|
| `GET /` | landing page, with an `Add to wallet` button |
| `POST /rpc` | JSON-RPC (single or batch) |
| WebSocket upgrade (any path) | JSON-RPC over WS, plus `eth_subscribe` |
| `GET /api`, `/v2/api` | Etherscan v2-compatible endpoint |
| `GET /tx/<hash>` | tx explorer: fields, logs, full state diff, signed message when there is one. A hash the sandbox doesn't know redirects to the upstream explorer |
| `GET /address/<addr>` | address explorer: overlay snapshot vs upstream values, plus the account's sandbox txs |
| `GET /txs`, `/accounts` | list pages, with undo buttons |
| `POST /undo/{last\|<hash>}` | LIFO undo, then a 303 back to where you came from |
| `GET /import` | cross-chain balance import page |
| `GET /admin` | impersonation, clear-sandbox and set-code tools (admin-gated, EIP-712) |

Every response carries `Cache-Control: no-store`, `Pragma: no-cache` and
`Expires: 0`, plus CORS headers; upstream cache directives are dropped during
relay. `OPTIONS` is answered as a 204 preflight. The WebSocket upgrade bypasses
CORS, since the handshake writes its own headers.

## JSON-RPC surface

Methods fall into three groups.

**Answered locally, sandbox-aware:**

| method | behavior |
|---|---|
| `eth_chainId`, `net_version` | the sandbox chain id |
| `fakereum_transactionMessage`, `fakereum_sendTransaction` | [signed-message transactions](#signed-message-transactions-eip-191) — the default send path |
| `eth_sendRawTransaction` | executes signed RLP locally, commits, returns the hash |
| `eth_call`, `eth_estimateGas` | overlay-aware; see [storage modes](#eth_call-storage-modes) |
| `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt` | overlay → upstream, subject to the [block tag](#block-tag) rule |
| `eth_getTransactionByHash`, `eth_getTransactionReceipt` | sandbox txs answer locally, everything else proxies |
| `eth_getLogs` | upstream result plus matching sandbox logs |
| `eth_getBlockByNumber` at `latest`/`pending` | upstream block with the [head clock](#head-clock) timestamp |
| `fakereum_accountKind` | [account kind](#replay-guard-and-account-kinds) of an address |
| `fakereum_importSources`, `fakereum_importMessage`, `fakereum_importBalance` | [cross-chain import](#balances-upstream--1000-and-cross-chain-import) |
| `fakereum_undoLastTx`, `fakereum_undoBackTo` | [undo](#undo) |
| `fakereum_listImpersonators`, `fakereum_setImpersonator`, `fakereum_removeImpersonator`, `fakereum_setCode`, `fakereum_clearSandbox` | [admin operations](#admin-operations) |

**Refused**, because they would either sign with a key the sandbox doesn't have
or imply a mempool it doesn't have: `eth_sendTransaction`,
`eth_signTransaction`, `eth_sendBundle`, `eth_sendPrivateTransaction`,
`eth_sendPrivateRawTransaction`, `eth_cancelPrivateTransaction`. The error
names the alternatives — `fakereum_sendTransaction` with an EIP-191 signature,
or `eth_sendRawTransaction`.

**Everything else** is forwarded upstream with failover, its impersonation
rewrites applied in both directions.

Batch requests are handled element-wise and in parallel. An upstream failure
inside one element becomes that element's JSON-RPC error rather than a failed
batch.

### WebSocket subscriptions

`eth_subscribe` supports `newHeads` and `logs`. Both are **sandbox-driven**:
after a sandbox tx lands, subscribers get a head frame and any of the tx's logs
matching their filter. Upstream push is not bridged — there is no long-lived
upstream socket — so real-chain blocks and logs do not arrive this way. Any
other JSON-RPC method sent over the socket is answered exactly as on `/rpc`.
Sockets are accepted through the hibernation API, so an idle connection costs
nothing, and each socket's subscriptions are serialized into its attachment.

### Block tag

The overlay is the **sandbox tip** — the merged real + sandbox state. State
reads that carry a block parameter (`eth_call`, `eth_estimateGas`,
`eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`)
honor it with fork semantics:

- `latest` / `pending` / `safe` / `finalized` (or omitted), and any block number
  at or after the block the **first sandbox tx** landed in → the **sandbox tip**,
  overlay on. While the sandbox holds no tx at all, every numeric block reads the
  tip too.
- A concrete past block — a number **below** the first sandbox tx's block, a
  block **hash**, or `earliest` → the **real chain** at that block, overlay off,
  forwarded verbatim. Such blocks predate every sandbox mutation. The EIP-1898
  object form (`{blockNumber}` / `{blockHash}`) is accepted as well.

Comparing against the first sandbox block rather than the moving real tip is
deliberate: wallets rarely send `latest` — MetaMask rewrites it into the block
its tracker last saw — and on a chain minting a block every few hundred
milliseconds the real tip is already past that number when the request lands.
Comparing against the tip would send every wallet read upstream with the
overlay off, hiding sandbox balances and deployments. No block-tag decision
costs a subrequest, and an unparseable tag falls back to the tip.

### Head clock

The sandbox tip's `block.timestamp` is the later of the upstream head's own
timestamp and wall clock, not whatever the upstream node's latest header says.
Two things make that header drift from real time: a lagging failover node can
sit tens of seconds behind the chain, and a chain that only mints blocks when
there is traffic keeps its last header's time until the next tx lands. Either
way a contract checking a deadline, a vesting cliff or an auction end sees a
clock that stopped.

Every consumer gets the corrected clock:

- **`eth_sendRawTransaction`**, `fakereum_sendTransaction` and the local-mode
  `eth_call` / `eth_estimateGas` execute against a block context carrying it
  (the receipt's `blockTime` too).
- **Forwarded `eth_call` / `eth_estimateGas`** carry it as geth's 4th positional
  `blockOverrides: { time }`. Nitro, geth and reth all honor it. A node that
  refuses the 4-param shape (`-32602 too many arguments`, or drpc's
  `expect 1 required and 3 optional params`) gets the plain 3-param call
  instead, and that refusal is remembered per method for ten minutes — but only
  once the plain retry is accepted, so a caller's own malformed request never
  switches the feature off.
- **`eth_getBlockByNumber`** at `latest` / `pending` reports the upstream block
  with its `timestamp` moved to the same clock, so a UI reading the head block
  agrees with what contracts see. Fixed blocks, `safe` and `finalized` pass
  through untouched.

The block **number** never moves — only the clock.

### `eth_call` storage modes

`eth_call` and `eth_estimateGas` need contract storage to execute. Two
strategies:

- **`stateOverride`** (default) — the call is forwarded upstream as
  `eth_call(args, "latest", overlay-as-stateOverrides, blockOverrides)`.
  Upstream's EVM does the SLOADs internally: **one subrequest per call**,
  whatever the call touches. This is the only Free-plan-safe choice, and it is
  faster for read-heavy dapps regardless.
- **`getStorageAt`** — the EVM runs locally and each cold SLOAD costs an upstream
  fetch. Useful against an upstream that doesn't honor state overrides; it can
  exceed the Free plan's 50-subrequest cap on a heavy call.

In `stateOverride` mode the sender's balance is also overridden with what the
sandbox would show it holding (see [balances](#balances-upstream--1000-and-cross-chain-import)),
so value and gas checks match what a transaction here would do. Caller-supplied
overrides are merged on top of the overlay's, per account and per field, so a
caller can override exactly what it wants without losing the sandbox state.

Gas estimates in local mode are `intrinsic + execution` with a geth-style 25%
pad.

### State overrides

The geth-style third parameter is honored on both methods:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_call",
  "params": [
    { "to": "0x…", "data": "0x70a08231…" },
    "latest",
    {
      "0xabc…": {
        "balance":   "0x100",
        "nonce":     "0x0",
        "code":      "0x60…",
        "state":     { "0x…01": "0x…feed" },
        "stateDiff": { "0x…02": "0x…cafe" }
      }
    }
  ]
}
```

`balance` / `nonce` / `code` replace the field. `state` is a full replace —
slots not listed read as zero, with no fall-through for that account.
`stateDiff` is a patch — unlisted slots still fall through to overlay, then
upstream. Overrides apply for the duration of the call and are never persisted.

### `eth_getLogs`

The upstream result and the matching sandbox logs are concatenated. If upstream
returns an error — a range limit, a rate limit — it is returned verbatim rather
than being silently degraded to sandbox-only, because a caller that asked for a
10M-block range needs to know its request was refused. (The
[Etherscan endpoint](#etherscan-compatible-endpoint) makes the opposite choice,
for reasons explained there.)

## Balances: upstream × 1000, and cross-chain import

An account that has no balance of its own in the sandbox yet is shown holding
**its upstream native balance × `BALANCE_MULTIPLIER`** (default 1000). That is
what `eth_getBalance` answers, what a transaction here can spend, and what
forwarded `eth_call` / `eth_estimateGas` see for their `from`. The scaling is
applied where the sandbox materializes a balance from upstream; the raw
upstream read the replay guard uses stays unscaled.

From the account's first landed transaction on (or its import, below), the
overlay holds the balance and upstream no longer matters — the commit step sets
it explicitly if execution happened to leave it untouched. The `/address/<addr>`
page marks a figure that is still scaled from upstream. Set
`BALANCE_MULTIPLIER=1` to turn this off.

Funds on **another** EVM chain can be brought in once per account through
`/import`. Supported sources are Ethereum Mainnet, Arbitrum One, Base, Hemi and
Robinhood Chain, minus the sandbox's own upstream — that one is automatic. The
page connects a wallet, lists the account's balance on each source, and after a
`personal_sign` of

```
Fakereum Import to <upstream chain name>
Account: <EIP-55 address>
From: <chain name> (chain id <id>)
```

credits `balance × multiplier` on top of whatever the account shows now. The
wallet may be on any chain to sign; the message is not a transaction anywhere.
An account can import **once, from one chain, ever** — the record lives next to
the account kinds and survives a sandbox clear. A zero source balance or a
failed source read is refused without consuming the import. The import counts
as a signed write by the account and pins its kind like a landed tx.

| method | params | result |
|---|---|---|
| `fakereum_importSources` | `[address]` | `{ account, multiplier, imported, sources: [{chainId, name, symbol, balance, credit} \| {…, error}] }` |
| `fakereum_importMessage` | `[{account, chainId}]` | `{ message }` |
| `fakereum_importBalance` | `[{account, chainId, signature}]` | `{ account, chainId, chain, balance, credit, newBalance }` |

## Transactions

Wallets do not relay `fakereum_*` methods, so a dapp signs through the wallet
and POSTs the calls below straight to the sandbox's `/rpc` URL. That is exactly
what lets a wallet parked on the real chain — or on any other chain — drive the
sandbox without being repointed.

### Signed-message transactions (EIP-191)

This is the default way to send. The signature binds the nonce, recipient,
value and calldata; gas limit and fee terms travel unsigned in the RPC params
(this is a test sandbox, and nothing harmful can be done with them without the
binding signature). The sandbox then executes a normal legacy or EIP-1559
transaction from the recovered signer: same nonce and balance checks, same fee
accounting, same impersonation NAT as a raw transaction, a real transaction
hash, a real receipt.

Why it is the default rather than a curiosity: `personal_sign` is
chain-agnostic and produces nothing any node would accept as a transaction. So
the user's wallet can stay on the real chain — no network switch, no custom RPC
— and an account holding real funds can drive the fork without ever signing
something replayable.

| method | params | result |
|---|---|---|
| `fakereum_transactionMessage` | `[{from?, to?, value?, data?, nonce?}]` | `{ message, nonce }` — the text to sign; nonce read from the sandbox when omitted (needs `from`); omit `to` to deploy |
| `fakereum_sendTransaction` | `[{to?, value?, data?, nonce, gas?, gasPrice? \| maxFeePerGas?, maxPriorityFeePerGas?, signature}]` | tx hash |

Fields are named and encoded as in `eth_sendTransaction` — 0x-hex quantities,
0x-hex `data`. Omitted gas terms are filled the way a wallet would: `gas` from
the local estimate for the recovered signer, and an EIP-1559 cap at the
upstream gas price with no tip.

The text, lines joined by `\n`, no trailing newline:

```
Fakereum Tx #13 on <upstream chain name>       ← e.g. "on Arbitrum One", never "Fake …"
To: <EIP-55 address>                           ← "To: CREATE" for a deploy (no `to`)
Value: 0.001                                   ← only when value > 0
Data: 0x12345678 and 68 bytes with hash 0x…    ← only when data is non-empty (init code for a deploy)
```

The header carries the nonce and the name of the chain the sandbox forks (also
published by [discovery](#discovery)), so a client can build the text offline.
`Value` is in whole native units with up to 18 fractional digits, trailing
zeros dropped — exact for any wei amount. `Data` shows the first four bytes;
when more follow, their count and the keccak256 of those trailing bytes.

What differs from a raw tx:

- **No replay guard.** A `personal_sign` message is not a transaction on any
  chain, so it can't be replayed upstream even when the chain ids match. Like
  any landed tx it pins the signer's kind. The impersonatee guard and the
  impersonation NAT still apply.
- **Hash and raw bytes are those of the constructed tx.** The legacy or
  EIP-1559 transaction is built with the message signature's r/s/v in its own
  signature fields, so it serializes and hashes like any transaction; its v/r/s
  just recover a stranger rather than the sender, which is why `from` /
  `signedBy` (and the `signedMessage` field) are the authority. Re-sending the
  same signed message is refused: the nonce is stale, and an identical hash
  answers `already known`.
- `eth_getTransactionByHash`, the receipt and the `/tx/<hash>` page carry a
  `signedMessage: {message, signature}` next to the ordinary fields; the page
  shows the signed text above the raw transaction.

#### Nonces

There is no mempool: `fakereum_sendTransaction` executes on arrival, so the
signed nonce must equal the account's nonce at that moment. Since signing is a
human round trip, two sends fired together — approve, then swap — would both
read the same nonce while the first prompt is still open, and whichever landed
second would be refused.

Sign **one at a time per account**, counting a nonce as spent the moment a
well-formed signature comes back rather than when the transaction lands, and
submit in signing order. A cancelled prompt spends nothing. `createNonceManager()`
in the SDK does this, and `createSandboxProvider` uses it automatically.

### Raw transactions

`eth_sendRawTransaction` takes ordinary signed RLP, using the sandbox chain id
that `eth_chainId` reports:

```js
const provider = new ethers.JsonRpcProvider("https://fakereum-42161.derion.io/rpc")
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
const tx = await wallet.sendTransaction({ to: "0x…", value: ethers.parseEther("1") })
const receipt = await tx.wait()
```

This is the path for scripts and test harnesses holding a private key, and for
wallets repointed at a sandbox that runs on its own chain id. On a sandbox
sharing the real chain id — which every deployment listed above does — the
[replay guard](#replay-guard-and-account-kinds) refuses raw transactions from
any account that holds native token on the real chain, because those signed
bytes would be valid there. Such an account sends signed messages instead.

### Execution semantics

Both paths land in the same executor. There is no mempool and no mining: the
transaction executes on arrival, so the signed nonce must equal the account's
current one, and the receipt is available immediately. Failed transactions
still consume gas and bump the nonce, as on a real chain. If the signed
`maxFeePerGas` is below the upstream baseFee, the synthetic block's baseFee is
lowered to that cap so the transaction still lands. The reported block number
is the upstream tip at execution time, and the block time is the
[head clock](#head-clock).

### Per-tx state diff and internal deploys

Every sandbox tx records a complete state diff — every account field and
storage slot it changed, with both pre and post values, and whether the overlay
already held that field. It's shown on `/tx/<hash>` and persisted with the tx.

The diff also tracks contracts deployed **inside** the transaction (factory
patterns, CREATE2), not just the top-level deploy the receipt's
`contractAddress` exposes, and records how each one was created.

### Undo

LIFO undo of sandbox transactions:

- `fakereum_undoLastTx` — pops the most recently submitted tx, rewinds the
  overlay with its diff, removes its receipt and logs. Returns the popped hash.
- `fakereum_undoBackTo(txHash)` — undoes every tx submitted after the given
  hash, plus that one, in LIFO order. Returns the popped hashes, newest first.

Equivalent buttons live on `/txs` and `/tx/<hash>`; both POST to
`/undo/{last|<hash>}` and redirect back.

Rewinding restores each changed field to its pre-tx value, or removes the
overlay entry entirely when the overlay held nothing for that field before —
so an undone account falls through to upstream again, exactly as it did before
the transaction.

Undo refuses any tx that self-destructed an account: the diff captures only the
slots the tx touched, so a destroyed contract's full storage can't be perfectly
restored.

## Replay guard and account kinds

By default the sandbox runs on a **distinct** chain id (`420<upstreamId>`), so
an EIP-155 transaction signed for it carries a chain id the real network won't
accept — it can never be replayed upstream. But running on the **real** chain
id is far more convenient (no network switch, no re-add, tools that hardcode
the id keep working), and then every transaction signed for the sandbox is
byte-for-byte valid on the real chain. Anyone who captures those signed bytes —
a logging proxy, a shared RPC, a leaked mempool — can rebroadcast them and
execute the transaction for real.

The replay guard closes that hole: it **rejects any `eth_sendRawTransaction`
whose recovered signer holds a non-zero native balance on the upstream chain**.
A wallet with no real balance can't pay gas on the real chain, so a replayed
transaction from it is inert. The guard is on by default whenever the sandbox
and upstream chain ids match, off otherwise, and `REJECT_UPSTREAM_SIGNERS`
overrides either way.

The check uses the address that **physically signed**, so it also covers
impersonator keys — the impersonator's signature is the artifact that would be
replayed, even though the EVM treats the transaction as coming from the
impersonatee.

With the guard on, every account the sandbox meets is pinned as one of two
kinds:

| kind | decided by | consequence |
|---|---|---|
| `upstream` | native balance > 0 on the real chain at its first sandbox tx | raw txs refused by the guard; sends as EIP-191 signed messages |
| `sandbox` | zero upstream balance at its first sandbox tx | ordinary wallet flows |

Pinning happens **on write only**: the account's first transaction that lands —
raw or signed message, reverted or not; a refused or failed send pins nothing —
stores the verdict the guard looked up, and it survives restarts and
`fakereum_clearSandbox` (it's a fact about the real chain, not sandbox state).
Once pinned, the guard stops re-reading balances: a burner topped up upstream
later stays `sandbox`, a real account that empties itself stays `upstream`.

`fakereum_accountKind [address]` answers `{ address, kind, pinned, replayGuard }`
and never pins. Before the first tx it reports the live balance with
`pinned: false`; afterwards the stored verdict with `pinned: true`. With the
guard off, nothing can replay, so it answers `sandbox` for everyone without
consulting upstream.

A rejected transaction comes back as a JSON-RPC error naming the funded signer
and pointing at the signed-message path.

## Using it from a dapp

The quickest way is the SDK in [`sdk/`](sdk/README.md) (`fakereum-sdk`): a small
framework-agnostic package with `discover()`, `accountKind()`, the
signed-message helpers plus an offline message builder, and
`createSandboxProvider({ sandbox, wallet })`, an EIP-1193 wrapper that does
everything below — routes reads to the sandbox, turns `eth_sendTransaction`
into a signed-message transaction (or lets the wallet send when it is already
on this sandbox and the account is of the `sandbox` kind), refuses typed-data
requests for `upstream` accounts, serializes nonces per account, and caches
kinds until pinned. One line wires it into ethers v5 (`new Web3Provider(p)`),
ethers v6 (`new BrowserProvider(p)`), viem (`custom(p)`) or a wagmi connector
override. Build it with `npm run build:sdk`.

Two setups exist, differing in who knows about the fork. The first is the
normal one, and the one signed-message transactions were built for — the user
keeps whatever wallet they already have, on whatever network it is already on:

- **Fork-aware dapp, normal wallet.** The wallet (MetaMask, Brave, …) stays on
  the real chain's RPC. The dapp is configured with the sandbox base URL, reads
  its endpoints from the sentinel *on the sandbox RPC* (or hardcodes them), and
  does every read there: balances, `eth_call`, estimates, receipts on `rpc`,
  logs on `etherscanApi`. The wallet's provider serves only
  `eth_requestAccounts`, `personal_sign` and, for `sandbox`-kind accounts,
  `eth_signTypedData_v4`. `eth_sendTransaction` on it would broadcast to the
  real chain, so every sandbox transaction travels as an EIP-191 signed message.
- **Wallet repointed to the sandbox** (the landing page's *Add to wallet*). The
  dapp detects this with an `eth_call` to the sentinel on the wallet's RPC and
  swaps its endpoints. `eth_sendTransaction` through the wallet reaches the
  sandbox.

In both, when the user sends, the dapp asks `fakereum_accountKind [address]`
and applies:

- **`upstream`:** signed messages only, in either setup. Never request a
  transaction signature or any EIP-712 typed-data signature from this account
  while it is on the sandbox — Permit and Permit2 included — because with a
  shared chain id those signatures replay on the real chain. The replay guard
  refuses the account's raw transactions for the same reason, but it cannot see
  typed-data signatures, so the dapp has to hold that line itself.
- **`sandbox`:** EIP-712 requests are fine; an empty account has nothing to lose
  to a replay. The transaction itself goes through the signed-message path in
  the fork-aware setup, or through the wallet's `eth_sendTransaction` when the
  wallet is repointed. The account needs FETH inside the fork for gas (import
  some from another chain, or receive a transfer), and a later deposit on the
  real chain does not move it back to `upstream`.

## State conflicts

The overlay stores **post-state**, not deltas. Reads return `overlay →
upstream@latest`, so any field or slot a sandbox tx has written is pinned to
that sandbox value — even when the real chain mutates the same slot afterwards.
Drift is *localized*: only the fields the sandbox actually touched. Everything
else still tracks upstream live.

Concrete cases:

- **Balance drift.** A sandbox tx debits Alice's USDC slot (upstream 1000 →
  overlay 900). The real chain later credits her 500 (upstream now 1500). The
  sandbox keeps reporting 900.
- **Nonce drift.** A sandbox tx bumps Alice's nonce 5 → 6. She also broadcasts a
  real tx at nonce 5 (upstream now 6). The next sandbox tx signs with nonce 7
  though only nonce 6 exists on the real chain — the sandbox sequence won't
  replay there.
- **Code / delegation.** A sandbox tx (or a genesis seed) installs code at
  address X and the real chain later installs different code there. The overlay
  wins. The symmetric case bites too: a real-chain EIP-7702 delegation on an EOA
  bleeds through into the sandbox, because the overlay has nothing to override.

Sandbox transactions are never re-executed against a newer upstream tip. Doing
so would mean either pinning to a fork block — giving up the live-mirror
property — or replaying the entire sandbox history per read, which is expensive
and non-deterministic once sandbox calldata reads live values.

Mitigations, roughly in order of bluntness:

- **Undo recent txs** so the affected fields fall through to upstream again.
  Best when the drift traces to one specific transaction.
- **Clear the sandbox** (admin, below) for a clean slate, optionally keeping
  balances and nonces.
- **Transact from disposable addresses.** Burner and genesis-seeded addresses
  rarely see real-chain activity, so drift stays minimal.
- **Read live state before writing.** If you need a pool's pre-trade price,
  query it before submitting the sandbox swap, or read from an account whose
  overlay fields aren't touched.

## Account impersonation

Impersonation lets a signer key **`B`** act as a real account **`A`** inside the
sandbox — drive a dapp as a whale, a multisig or a protocol account whose
private key you don't hold, against forked state. Map `B → A` on `/admin`
(connect a wallet, sign an EIP-712 message from a configured admin) or seed it
with `IMPERSONATE`.

Once mapped, **`B` is a transparent proxy onto `A`**: it holds no state or
balance of its own, and a dapp connected as `B` sees everything the
impersonatee would — except the connected address itself, which stays `B`
(your wallet reports that over EIP-1193; it never transits the sandbox).

- **Writes execute as `A`.** A transaction recovering to `B` runs with
  `msg.sender == A`: `A`'s balance pays gas, `A`'s nonce advances, and the
  `ecrecover` precompile reports `A` for `B`'s signature, so on-chain signature
  checks (Permit, ERC-4337, EIP-1271) hold. `B` is never debited or
  nonce-bumped. The physical signer is recorded on the receipt as `signedBy`.
- **The impersonatee `A` cannot sign directly.** Any sandbox transaction whose
  signature recovers to a configured impersonatee is rejected — `A` is meant to
  be driven only through `B`. This is checked *ahead of* the replay guard and
  applies regardless of the guard's setting, so it costs no upstream read.
- **Reads are a two-way NAT.** Requests mentioning `B` are rewritten to `A`
  before dispatch, and `A` is relabeled back to `B` in the response, so the dapp
  — which knows itself as `B` and matches returned data against `B` —
  recognizes the data as its own. The dapp lives in "`B`-space", upstream lives
  in "`A`-space". Covered surfaces:
  - **Request `B → A`:** `eth_getBalance` / `eth_getTransactionCount` /
    `eth_getCode` / `eth_getProof`; `eth_call` / `eth_estimateGas` /
    `eth_createAccessList` (`from`, address-shaped calldata slots, state-override
    keys); `eth_getLogs` and `eth_subscribe("logs")` filters (address + indexed
    topics); Etherscan `address=` (including the comma-separated form) and
    `topic0..topic3`.
  - **Response `A → B`:** `eth_getLogs` and WS log pushes (address, indexed
    topics, address-shaped data slots); `eth_call` return data;
    `eth_getTransaction*` and receipts (`from` / `to` / `contractAddress` and
    embedded logs); `eth_getProof`; Etherscan account actions and `getLogs`
    entries.

Three seams follow from "`B` acts as `A`" and are by design:

- **Ambiguous reverse is skipped.** The map is many-to-one, so when one `A` has
  several impersonators the response relabel can't pick a single `B`; those
  responses show `A`. Keep mappings 1:1 for a seamless alias.
- **`eth_getStorageAt` is not rewritten.** It addresses a *contract*, not a
  wallet, and its raw 32-byte values are left alone — so reading a hand-computed
  `balanceOf[B]` slot returns `B`'s (empty) slot. Use `eth_call`.
- **Calldata rewriting is positional-blind.** Any address-shaped 32-byte slot
  equal to `B` is rewritten to `A` regardless of the argument's role. A
  `uint256 ≥ 2^160` can't collide, but an address-typed `spender` argument equal
  to `B` would. Pick impersonator keys distinct from addresses you pass as data.

Impersonated transactions carry **no signature-level replay protection**: the
nonce is forced to `A`'s current nonce, so resubmitting the same raw bytes
executes again rather than failing on a nonce mismatch. The executor guards
against the degenerate case — a second landing under the same hash is refused
with `already known`.

## Admin operations

Three mutations are gated on a configured admin address. Each is signed as
EIP-712 under the domain
`EIP712Domain(string name, string version, uint256 chainId)` with
`name = "fakereum-impersonate"`, `version = "1"` and the sandbox chain id; the
recovered signer must be in `ADMINS`. With no admins configured, all three
answer "not enabled". `/admin` drives them from a browser wallet.

| method | signed struct | effect |
|---|---|---|
| `fakereum_setImpersonator` | `SetImpersonator(address impersonator, address impersonatee)` | map `B → A` |
| `fakereum_removeImpersonator` | `RemoveImpersonator(address impersonator)` | drop the mapping |
| `fakereum_setCode` | `SetCode(address account, bytes code)` | replace an account's bytecode |
| `fakereum_clearSandbox` | `ClearSandbox(address[] include, address[] exclude, bool keepNonzeroNonce, bool keepBalances)` | reset sandbox state |

`fakereum_listImpersonators` is an open read.

**Set code** installs an overlay code override, leaving balance, nonce and
storage untouched. It works uniformly for upstream contracts (whose real code
would otherwise be fetched) and sandbox-deployed ones, because every code read
consults the overlay first. Empty code makes the address report as codeless; to
restore an upstream contract's real code, clear that account instead.

**Clear sandbox** takes an account scope and two keep flags, all part of the
signed message so a tampered request can't widen what the admin approved:

- `include` empty means every overlay account; `exclude` always wins.
- For each in-scope account, **code and storage are always wiped**.
- `keepBalances` retains the balance, and `keepNonzeroNonce` retains a non-zero
  nonce — **for EOAs only**. A contract is cleared in full: its nonce is ≥ 1 the
  moment it's deployed and carries no wallet-facing meaning, so keeping it would
  make every deployed contract survive a clear.
- An account left with nothing is deleted; one that keeps a balance or nonce
  stays as a slimmed entry.
- Recorded sandbox transactions of in-scope senders go too, regardless of the
  keep flags — a retained nonce is just the count `eth_getTransactionCount`
  reports, decoupled from history.

What a clear deliberately does **not** touch: pinned account kinds, import
records, and the upstream code cache. Those are facts about the real chain, not
sandbox state.

## Genesis seed

`GENESIS` pre-populates the overlay with a geth-compatible `alloc` map — useful
for funding test accounts or installing mock contracts before any transaction
fires.

```json
{
  "alloc": {
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266": { "balance": "0x56bc75e2d63100000" },
    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": {
      "balance": "0xde0b6b3a7640000",
      "nonce":   "0x2a",
      "code":    "0x604260005260206000f3",
      "storage": { "0x0000…0007": "0x0000…beef" }
    }
  }
}
```

It is applied **once per deployment**, on the first request after the flag is
absent from storage, and it is **fill-only**: existing overlay fields and slots
always win, so genesis only fills what the sandbox hasn't touched. Malformed
JSON is ignored rather than fatal. To reseed with new values, clear the sandbox
first.

## Etherscan-compatible endpoint

`/api` and `/v2/api` forward to the configured upstream explorer. Only
`module=logs&action=getLogs` gets sandbox-aware treatment — that's the endpoint
that has to merge with locally emitted events. Every other module (account,
contract, block, proxy, stats, …) is passthrough with the chain param rewritten
to the real upstream id, because a dapp parrots back the sandbox chain id,
which no explorer indexes.

On the `getLogs` path:

- **Block numbers are normalized** to whatever the upstream dialect wants.
  Etherscan v2 silently returns no records for bare decimals; Blockscout's
  Etherscan-compat endpoint rejects 0x-hex with "Invalid fromBlock format".
- **Pairwise topic operators are auto-completed.** Explicit `topicI_J_opr=or`
  edges are closed transitively (union-find), so a chained OR like
  `topic1_2_opr=or & topic2_3_opr=or` survives even on strict backends that
  demand `topic1_3_opr` too. The same grouping drives the sandbox-side matcher —
  OR within a group, AND across groups — so a 3-topic OR returns the union of
  per-position hits rather than their (usually empty) intersection.
- **Upstream entries are filtered client-side** to the requested
  `[fromBlock, toBlock]`, since Etherscan ignores `fromBlock` once a topic
  produces more than its 1000-result cap.
- **Sandbox logs are merged in** and the result stable-sorted by
  `(blockNumber, logIndex)` — only when the sandbox actually contributed, so
  upstream's own ordering otherwise stands. Each sandbox record's `timeStamp` is
  recovered from its owning transaction at render time.
- **A failed upstream half doesn't erase the sandbox half.** If the explorer
  errors out but the sandbox matched logs, the answer carries the sandbox logs
  with an `OK (sandbox only, upstream unavailable: …)` message — OK-prefixed so
  Etherscan clients accept it, with the failure quoted so partial coverage stays
  visible. A fork-only log exists in no explorer index anywhere, and clients read
  a `NOTOK` as "no history", which makes an account's whole position list vanish
  from a dapp. When the sandbox has nothing either, the upstream payload is
  returned verbatim.

Operational details: the upstream call is bounded at 20 s (a gateway that
cannot serve a query has been seen sitting on it for 51 s before failing, and
on `getLogs` that wait also delays sandbox logs that were ready instantly). A
non-JSON body is reported as `explorer returned non-JSON (HTTP …, content-type)`
rather than a parser error, and upstream failures are reported as an Etherscan
`status: "0" / NOTOK` envelope over HTTP 200 — an origin 502 gets replaced by
Cloudflare's own bare error page, which would hide the diagnostic entirely.
Requests go out with a browser User-Agent, because some Blockscout instances
answer a bare fetch with a Cloudflare challenge page.

**API keys.** On an Etherscan upstream the caller must supply its own `apikey`
and it is passed straight through, so public traffic never spends the
operator's quota; a request without one is refused with a message saying so.
On a Blockscout upstream it's the other way round — a single-chain instance
needs no key, while the multichain PRO gateway refuses anonymous requests with
HTTP 402 — so the configured key is injected there, still behind a
caller-supplied one when there is any. Configured keys are round-robined.

## Discovery

A dapp connected through an injected wallet never learns the RPC URL — the
wallet keeps it and exposes only `chainId` and accounts — so it can't derive
the matching Etherscan or explorer URLs on its own. And wallets reject custom
`fakereum_*` methods. So discovery rides on `eth_call`, which they always
forward.

An `eth_call` to the reserved address
`0x000000000000000000000000000000000000fa4e` returns the sandbox info,
ABI-encoded as a single `string` holding JSON. Calldata is ignored. No real
chain has code there, so a non-sandbox chain returns `0x` — which makes this a
clean "am I on a fakereum sandbox?" probe as well.

```js
const SENTINEL = "0x000000000000000000000000000000000000fa4e"
const ret = await window.ethereum.request({ method: "eth_call", params: [{ to: SENTINEL }, "latest"] })
const [json] = decodeAbiParameters([{ type: "string" }], ret)   // viem, or any `returns (string)` ABI
const infos = JSON.parse(json)
```

Tools wired straight to the RPC URL hit the same sentinel — it's a plain
`eth_call`, no wallet required:

```sh
curl -s $RPC -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x000000000000000000000000000000000000fa4e"},"latest"]}'
```

The decoded object:

| field | example | notes |
|---|---|---|
| `chainId` | `"0xa4b1"` | sandbox chain id, hex — matches `eth_chainId` |
| `upstreamChainId` | `"0xa4b1"` | the forked chain's id, hex |
| `networkName`, `symbol` | `"Fake Arbitrum One"`, `"FETH"` | sandbox network name and currency symbol |
| `upstreamChainName` | `"Arbitrum One"` | the forked chain's name — the header of every signed message |
| `rpc` | `https://host/rpc` | echo of the URL the request arrived on |
| `etherscanApi`, `etherscanApiV2` | `https://host/api`, `…/v2/api` | the overlay-aware explorer proxy — point the dapp here, not at upstream |
| `explorer` | `https://host` | sandbox explorer base (`/tx/<hash>`, `/address/<addr>`) |
| `upstreamRpc` | `https://arbitrum-one-rpc.publicnode.com` | the primary upstream endpoint |
| `upstreamExplorer` | `{name, url}` | public explorer of the forked chain, for cross-links |

The `rpc`, `etherscanApi` and `explorer` URLs are derived from the request's own
`Host` (honoring `X-Forwarded-Proto` / `X-Forwarded-Host`), so they're reachable
exactly the way the caller reached the sandbox.

## Rate limiting

`RATE_LIMIT_RPS` enables a per-IP token bucket keyed on `CF-Connecting-IP`.
Because it lives inside the single-threaded Durable Object, every request passes
through the same counter — there is no per-isolate approximation. Burst is
`2 × rps`, and a fresh bucket starts full, so a dapp's page-load fan-out spends
the burst first. A throttled request gets HTTP 429 with `Retry-After` in whole
seconds. `RATE_LIMIT_EXEMPT` takes IPs and CIDRs in either family (v4 addresses
are compared as v4-mapped v6, so one prefix check covers both).

## Repo layout

```
src/index.ts              front Worker: forwards into the DO
src/do/sandbox_do.ts      the EvmSandbox Durable Object: routing, RPC, persistence, WS
src/executor.ts           EVM driver: raw + signed-message txs, local calls, prefetch
src/statemanager.ts       async StateManager: overlay over upstream, diff capture
src/overlay.ts            the sticky overlay: commit, reverse-diff, genesis, clear
src/sandbox.ts            executed txs, logs, filters
src/fetcher.ts            read-through upstream state reader + caches
src/upstream.ts           JSON-RPC client: failover, batching, head guard
src/head.ts               head clock and the blockOverrides fallback
src/etherscan.ts          Etherscan query rewriting, topic closure, getLogs merge
src/message_tx.ts         EIP-191 signed-message transaction RPCs
src/account_kind.ts       upstream/sandbox pinning
src/import_balance.ts     cross-chain balance import
src/impersonate/          B↔A map, request/response NAT, admin RPCs
src/ui/                   landing, explorer, lists, import, admin pages
src/lib/                  hex, chains, blocktag, eip191, eip712, cors, rate limit, ipnet
pages/<chainid>/          per-chain Pages front door
sdk/                      fakereum-sdk, the client package
test/, sdk/test/          vitest suites + two live smoke scripts
```

## Status and known limits

As of the last check: **196 tests across 16 files pass** (`npm test`), and the
worker bundles for `workerd` at **~317 KB gzip** (`npm run build`), comfortably
under the Free plan's 3 MB script limit. Three forks are configured and
deployed — Arbitrum One, Robinhood Chain and Hemi — each as its own Worker,
Durable Object and Pages front door.

Free-plan constraints shape several defaults:

- **50 external subrequests per invocation.** `eth_call` / `eth_estimateGas`
  default to `stateOverride` mode (one subrequest per call), and transaction
  execution batches its cold reads. The `getStorageAt` mode fans out one fetch
  per cold SLOAD and can blow the cap on a heavy call — it's available, but it's
  Paid-plan territory.
- **30 s DO CPU.** A transfer or a moderate contract call is comfortable; a
  pathological DeFi transaction with a huge cold-state graph could approach it.
  Raising the limit requires Paid.
- **SQLite-backed Durable Objects only** on Free (the legacy key-value backend
  is Paid). The migration uses `new_sqlite_classes`.
- `[limits]` in `wrangler.toml` is a Paid feature and stays commented out.

Known gaps:

- **Explorer ABI decoding** shows raw calldata and logs. The decoder is wired,
  but nothing fetches verified ABIs yet, so decoded views need that follow-up.
- **No upstream WebSocket bridge.** `eth_subscribe` serves sandbox-driven
  `newHeads` and `logs` only; real-chain events don't push.
- **Undo and selfdestruct.** Undo refuses any tx that destroyed an account. The
  detection keys off account deletion in the state manager, which can also fire
  on EIP-158 empty-account pruning, so verify undo behavior on
  selfdestruct-heavy transactions before relying on it.
- **EIP-7702 setCode deploys** aren't captured as deploys: the EVM is pinned to
  Cancun. Moving to Prague also means carrying the header fields Prague requires
  on the synthetic block.
- **Impersonation caveats** — ambiguous reverse mapping, untouched
  `eth_getStorageAt`, positional-blind calldata rewriting — are described in
  full above.
