# Fakereum — Cloudflare Worker port

A JavaScript/TypeScript port of [fakereum](../fakereum) that runs on
**Cloudflare Workers (Free plan)**. Fakereum is a forked-EVM JSON-RPC sandbox:
it fronts any upstream EVM RPC, executes `eth_sendRawTransaction` **locally**
against a sticky state overlay layered on `upstream@latest`, commits the diffs
to the overlay, and serves merged real + sandbox reads over both Ethereum
JSON-RPC and an Etherscan-v2-compatible API.

This port keeps the Go version's behavior but swaps the runtime:

| Go version | This port |
|---|---|
| go-ethereum EVM (`vm.StateDB`, sync) | **EthereumJS v10** EVM + a custom **async** `StateManager` that lazily fetches cold state from upstream |
| Per-chain JSON files on disk | **SQLite-backed Durable Object** storage (`ctx.storage` key-value API) |
| Long-lived WebSocket to upstream | HTTP `fetch()` to upstream (request/response) |
| Single Go process + `sync.RWMutex` | One **Durable Object** per sandbox chain id (single-threaded = free mutex) |
| In-process per-IP rate limiter | Exact per-IP limiter inside the DO |

## Why a Durable Object runs the EVM

On the **Free plan** a plain Worker request gets only **10 ms** of CPU — far
too little for EVM execution. **Durable Objects get a 30 s CPU budget on every
plan, including Free.** So the front Worker (`src/index.ts`) is deliberately
thin: it forwards every request into the `EvmSandbox` Durable Object, which owns
all state and runs the EVM. Time spent `await`ing upstream `fetch()` is I/O, not
CPU, so lazy state reads don't burn the budget.

```
            ┌──────────── Cloudflare edge ─────────────┐
 dapp ─────▶│  Worker (src/index.ts)  — thin, forwards  │
 wallet     │        │ stub.fetch(request)               │
            │        ▼                                   │
            │  EvmSandbox  Durable Object (SQLite)       │
            │   overlay · sandbox txs/logs · executor    │
            │   (@ethereumjs/vm) · fetcher cache ·       │
            │   impersonators · client WebSockets        │
            └────────┼───────────────────────────────────┘
                     │ fetch() JSON-RPC + Etherscan
                     ▼
              upstream RPC (HTTP)
```

## Free-plan constraints (and how this port respects them)

- **50 external subrequests / invocation.** `eth_call`/`eth_estimateGas` default
  to **`stateOverride` mode**: the overlay is packed into one upstream
  `eth_call` (1 subrequest). The alternative `getStorageAt` local-EVM mode fans
  out one fetch per cold `SLOAD` and can blow the cap on heavy calls — it's
  available (`ETH_CALL_STORAGE_MODE=getStorageAt`) but is Paid-plan territory.
- **3 MB gzipped script limit.** Deps are tree-shaken (viem submodule imports,
  no `ethers`). Run `npm run build` (`wrangler deploy --dry-run --outdir dist`)
  to measure the real bundle before shipping.
- **30 s DO CPU.** A transfer or a moderate contract call is fine; a pathological
  DeFi tx with a huge cold-state graph could approach the limit (raising it
  above 30 s requires Paid).
- **SQLite-backed DO only** on Free (the legacy key-value backend is Paid). The
  `wrangler.toml` migration uses `new_sqlite_classes`; the port uses the
  `ctx.storage` key-value API, which SQLite-backed DOs still expose.

## Setup

Requires Node 20+ and a Cloudflare account (Free plan is enough).

```sh
cd fakereum.js
npm install
# one deployment per upstream chain, kept side by side:
#   - wrangler.toml [env.<chainid>] — worker name + [vars] for that chain
#   - pages/<chainid>/wrangler.toml — its public Pages front door
#   - .prod.vars.<chainid> (gitignored) — its secrets, see .prod.vars.example
npm run typecheck                  # tsc --noEmit
npm run dev                        # local: wrangler dev (config via .dev.vars)
npm run deploy:secrets -- 42161    # first deploy of a chain: code + secrets
npm run deploy -- 42161            # later deploys (secrets preserved)
npm run deploy:pages -- 42161      # the public Pages front door
```

For local dev secrets, copy `.dev.vars.example` to `.dev.vars`.

## Configuration

All knobs are `wrangler.toml` `[vars]` (or `wrangler secret` for the key). They
mirror the Go flags:

| var | meaning | default |
|---|---|---|
| `UPSTREAM_RPC` | upstream JSON-RPC URL(s), comma-separated for failover (`ws(s)://` is rewritten to `http(s)://`) | `https://ethereum-rpc.publicnode.com` |
| `UPSTREAM_ETHERSCAN` | upstream explorer base — Etherscan v2, a single-chain Blockscout, or Blockscout's multichain PRO gateway `https://api.blockscout.com/v2/api` (a URL containing `blockscout` switches to decimal getLogs blocks + the `chain_id` param) | `https://api.etherscan.io/v2/api` |
| `ETHERSCAN_API_KEY` *(secret)* | comma-separated keys; round-robin + rate-limit retry. On an Etherscan upstream it is internal-only and callers must bring their own `apikey`; on a Blockscout upstream it is also the fallback key for proxied `/api` traffic, since the PRO gateway refuses anonymous requests (HTTP 402) | (none) |
| `CHAIN_ID` | sandbox chain id; `0` = derive `420<upstreamId>` | `0` |
| `SYMBOL` / `NETWORK_NAME` | native symbol / network name | `F<sym>` / `Fake <name>` |
| `ETH_CALL_STORAGE_MODE` | `stateOverride` (Free-safe) or `getStorageAt` | `stateOverride` |
| `CACHE_TTL` | upstream read cache TTL, seconds | `12` |
| `REJECT_UPSTREAM_SIGNERS` | replay guard: `auto`/`true`/`false` | `auto` |
| `ADMINS` | comma-separated admin addresses (enables impersonation + clear) | (none) |
| `IMPERSONATE` | seed `B:A,B2:A2` (impersonator:impersonatee) | (none) |
| `CORS_ORIGINS` | comma-separated allowlist; empty = `*` | `*` |
| `RATE_LIMIT_RPS` | per-IP req/s; `<=0` disables | `0` |
| `GENESIS` | inline geth-style `{"alloc":{...}}` JSON | (none) |

## Routes

| route | purpose |
|---|---|
| `GET /` | landing page (`Add to wallet`) |
| `POST /rpc` (+ WS upgrade) | JSON-RPC; WebSocket `eth_subscribe` (newHeads/logs, sandbox-driven) |
| `/api`, `/v2/api` | Etherscan v2 proxy (sandbox getLogs merge — sandbox-only logs still answer when the upstream explorer is down — plus key rotation) |
| `/tx/<hash>` · `/address/<addr>` | HTML explorer |
| `/txs` · `/accounts` | list pages |
| `POST /undo/{last\|<hash>}` | LIFO undo |
| `/import` | import a native balance from another chain, once per account (EIP-191) |
| `/admin` | impersonation + clear-sandbox tools (EIP-712, admin-gated) |

Discovery: `eth_call` to `0x…fa4e` returns the ABI-encoded sandbox info string
(same sentinel as the Go version), now also carrying `upstreamRpc`, the primary
upstream URL, so a dapp can check an account's real-chain balance.

### Signed-message transactions (EIP-191)

A transaction can also arrive as a `personal_sign` message instead of signed
RLP. The signature binds the nonce, recipient, value and calldata; gas limit
and fee terms travel unsigned in the RPC params (this is a test sandbox, and
nothing harmful can be done with them without the binding signature). The
sandbox then executes a normal legacy or EIP-1559 transaction from the
recovered signer: same nonce and balance checks, same fee accounting, same
impersonation NAT as a raw tx. Two methods (`src/message_tx.ts`,
`src/lib/eip191.ts`):

| method | params | result |
|---|---|---|
| `fakereum_transactionMessage` | `[{from?, to?, value?, data?, nonce?}]` | `{ message, nonce }` — the text to sign; nonce read from the sandbox when omitted (needs `from`); omit `to` to deploy |
| `fakereum_sendTransaction` | `[{to?, value?, data?, nonce, gas?, gasPrice? \| maxFeePerGas?, maxPriorityFeePerGas?, signature}]` | tx hash |

Fields are named and encoded as in `eth_sendTransaction` (0x-hex quantities,
0x-hex `data`). Omitted gas terms are filled the way a wallet would: `gas`
from the local estimate for the recovered signer, and an EIP-1559 cap at the
upstream gas price with no tip. The text, lines joined by `\n`, no trailing
newline:

```
Fakereum Tx #13 on <networkName>
To: <EIP-55 address>                           ← "To: new contract" for a deploy (no `to`)
Value: 0.001                                   ← only when value > 0
Data: 0x12345678 and 68 bytes with hash 0x…    ← only when data is non-empty (init code for a deploy)
```

The header carries the nonce and the sandbox's `networkName` (the discovery
payload's), so a client can build the text offline. `Value` is in whole
native units with at most 10 fractional digits, trailing zeros dropped, so
the wei amount must be a multiple of 1e8 (the RPC refuses anything finer —
the text could not express it). `Data` shows the first four bytes; when more
follow, their count and the keccak256 of those trailing bytes.

What differs from a raw tx:

- **No replay guard.** A personal_sign message is not a transaction on any
  chain, so it cannot be replayed onto the upstream even when the chain ids
  match. Like any landed tx it pins the signer's kind (below). The impersonatee
  guard and impersonation NAT still apply.
- **Hash and raw bytes are those of the constructed tx.** The legacy or
  EIP-1559 tx is built with the message signature's r/s/v in its own
  signature fields, so it serializes and hashes like any tx; its v/r/s just
  recover a stranger rather than the sender, which is why `from`/`signedBy`
  (and the `signedMessage` field) are the authority. Re-sending the same
  signed message is refused: the nonce is stale, and an identical hash
  answers `already known`.
- `eth_getTransactionByHash` / receipts / the `/tx/<hash>` page carry a
  `signedMessage: {message, signature}` next to the ordinary tx fields; the
  page shows the signed text above the raw tx.

Because wallets do not relay `fakereum_*` methods, a dapp signs through the
wallet and POSTs the two calls directly to the sandbox's `/rpc` URL, which is
what makes this work from a wallet parked on any other chain.

### Account kinds

With the replay guard on, every account the sandbox meets is pinned as one of
two kinds (`src/account_kind.ts`, stored under `account:kind:<address>`):

| kind | decided by | consequence |
|---|---|---|
| `upstream` | native balance > 0 on the real chain at its first sandbox tx | raw txs refused by the replay guard; sends as EIP-191 signed messages |
| `sandbox` | zero upstream balance at its first sandbox tx | ordinary wallet flows |

Pinning happens on write only: the account's first transaction that lands
(raw or signed message, reverted or not — a refused or failed send pins
nothing) stores the verdict the guard looked up for it, which
survives restarts and `fakereum_clearSandbox` (it is a fact about the real
chain, not sandbox state). `fakereum_accountKind [address]` answers
`{ address, kind, pinned, replayGuard }` and never pins; before the first tx
it reports the live balance with `pinned: false`, afterwards the stored
verdict with `pinned: true`. Once pinned, the replay guard stops re-reading
balances too: a burner topped up upstream later stays `sandbox`, a real
account that empties itself stays `upstream`. With the guard off (distinct
chain id) nothing can replay, so the query answers `sandbox` for everyone
without consulting upstream.

### Balances: upstream × 1000, and cross-chain import

An account that has no balance of its own in the sandbox yet is shown holding
**its upstream native balance × `BALANCE_MULTIPLIER`** (default 1000): that
is what `eth_getBalance` answers, what a transaction here can spend, and what
forwarded `eth_call` / `eth_estimateGas` see for their `from`. The scaling is
applied where the sandbox materializes a balance from upstream
(`Fetcher.getBalance`); the raw upstream read the replay guard uses stays
unscaled. From the account's first landed transaction on (or its import,
below), the overlay holds the balance and upstream no longer matters — the
commit step sets it explicitly if execution happened to leave it untouched.
The `/address/<addr>` page marks a figure that is still scaled from upstream
"(upstream × 1000)". Set `BALANCE_MULTIPLIER=1` to turn this off.

Funds on **another** EVM chain can be brought in once per account through
`/import` (`src/import_balance.ts`, `src/lib/import_chains.ts`). Supported
sources: Ethereum Mainnet, Arbitrum One, Base, Robinhood Chain, minus the
sandbox's own upstream (that one is automatic). The page connects a wallet,
lists the account's balance on each source, and after a `personal_sign` of

```
Fakereum Import to <networkName>
Account: <EIP-55 address>
From: <chain name> (chain id <id>)
```

credits `balance × multiplier` on top of whatever the account shows now. The
wallet may be on any chain to sign; the message is not a transaction anywhere.
An account can import **once, from one chain, ever**: the record lives under
`import:<address>` next to the account kinds and survives
`fakereum_clearSandbox`. A zero source balance or a failed source read is
refused without consuming the import. The import counts as a signed write by
the account and pins its kind like a landed tx. RPC shape:

| method | params | result |
|---|---|---|
| `fakereum_importSources` | `[address]` | `{ account, multiplier, imported, sources: [{chainId, name, symbol, balance, credit} \| {…, error}] }` |
| `fakereum_importMessage` | `[{account, chainId}]` | `{ message }` |
| `fakereum_importBalance` | `[{account, chainId, signature}]` | `{ account, chainId, chain, balance, credit, newBalance }` |

### How a dapp should use it

The `fakereum` skill under `.claude/skills/` carries the code; this is the
shape. Two setups exist, differing in who knows about the fork:

- **Fork-aware dapp, normal wallet.** The wallet (MetaMask, Brave, …) stays
  on the real chain's RPC. The dapp is configured with the sandbox base URL,
  reads its endpoints from the sentinel *on the sandbox RPC* (or hardcodes
  them), and does every read there: balances, `eth_call`, estimates, receipts
  on `rpc`, logs on `etherscanApi`. The wallet's provider serves only
  `eth_requestAccounts`, `personal_sign` and, for `sandbox`-kind accounts,
  `eth_signTypedData_v4`. `eth_sendTransaction` on it would broadcast to the
  real chain, so every sandbox transaction travels as an EIP-191 signed
  message (`fakereum_transactionMessage` → `personal_sign` →
  `fakereum_sendTransaction`, POSTed to `rpc`).
- **Wallet repointed to the sandbox** (*Add to wallet*). The dapp detects
  this with an `eth_call` to the sentinel on the wallet's RPC and swaps its
  endpoints. `eth_sendTransaction` through the wallet reaches the sandbox.

In both, when the user sends, the dapp asks `fakereum_accountKind [address]`
(see above) and applies:

- **3a. `upstream`:** signed messages only, in either setup. Never request a
  transaction signature or any EIP-712 typed-data signature from this account
  while it is on the sandbox — Permit and Permit2 included — because with a
  shared chain id those signatures replay on the real chain. The replay guard
  refuses the account's raw transactions for the same reason, but it cannot
  see typed-data signatures, so the dapp has to hold that line itself.
- **3b. `sandbox`:** EIP-712 requests are fine; an empty account has nothing
  to lose to a replay. The transaction itself goes through the signed-message
  path in the fork-aware setup, or through the wallet's `eth_sendTransaction`
  when the wallet is repointed. The account needs FETH inside the fork for
  gas (import some from another chain, or receive a transfer), and a later
  deposit on the real chain does not move it back to 3a.

### Block tag

The overlay is the **sandbox tip** — the merged real + sandbox state. State
reads that carry a block parameter (`eth_call`, `eth_estimateGas`,
`eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`)
honor it with fork semantics:

- `latest` / `pending` / `safe` / `finalized` (or omitted), and any block
  number at or after the block the **first sandbox tx** landed in → the
  **sandbox tip** (overlay applied). While the sandbox holds no tx, every numeric
  block reads the tip too. This is deliberate: wallets never send `latest` —
  MetaMask rewrites it into the block its tracker last saw — and on a chain
  minting a block every few hundred ms the real tip is already past that number
  when the request lands. Comparing against the tip would send every wallet read
  upstream with the overlay off, hiding sandbox balances and deployments.
- A concrete past block — a number **below** the first sandbox tx's block, a
  block **hash**, or `earliest` (the EIP-1898 object form is accepted too) → the
  **real chain** at that block, overlay off. Such blocks predate every sandbox
  mutation, so they pass straight through to upstream. No block-tag decision
  costs a subrequest.

### Head clock

The sandbox tip's `block.timestamp` is the later of the upstream head's own
timestamp and wall clock, not whatever the upstream node's latest header says.
Two things make that header drift from real time: a lagging failover node can
sit tens of seconds behind the chain, and a chain that only mints blocks when
there is traffic keeps its last header's time until the next tx lands. Either
way a contract checking a deadline, a vesting cliff or an auction end sees a
clock that stopped. Every consumer gets the corrected clock:

- **`eth_sendRawTransaction`** and the local-mode `eth_call` / `eth_estimateGas`
  execute against a block context carrying it (the receipt's `blockTime` too).
- **Forwarded `eth_call` / `eth_estimateGas`** (default `stateOverride` mode)
  carry it as geth's 4th positional `blockOverrides: { time }`. Nitro, geth and
  reth all honor it. A node that refuses the 4-param shape (`-32602 too many
  arguments`, drpc's `expect 1 required and 3 optional params`) gets the plain
  3-param call instead, and that refusal is remembered per method for ten
  minutes — but only once the plain retry is accepted, so a caller's own
  malformed request never switches the feature off.
- **`eth_getBlockByNumber`** at `latest` / `pending` reports the upstream block
  with its `timestamp` moved to the same clock, so a UI reading the head block's
  time agrees with what contracts see. Fixed blocks, `safe` and `finalized`
  pass through untouched.

The block **number** never moves — only the clock. See `src/head.ts`.

### Monotonic head guard

A chain's head only grows, so the highest block number any upstream URL has
reported is a lower bound the real head always satisfies. A head read
(`eth_blockNumber`, `eth_getBlockByNumber` at `latest` / `pending`) answering
more than 64 blocks below that bound came from a backend that stopped following
the chain — `rpc.ordofi.network` fronts two nodes, one of them frozen hundreds
of blocks back, and round-robins between them. Such an answer fails over to
the next URL and benches the one that gave it for 30s, the same as a rate
limit. The margin absorbs honest skew between healthy nodes. Only when every
configured URL answers below the bound is the bound itself taken to be wrong,
and the best answer re-anchors it. Other methods carry no head to judge, so
`eth_call` is protected only indirectly, through the bench.

## Status & known limitations

**Verified locally** (TS 5.9, EthereumJS v10.1.2, against live Ethereum mainnet):

- `npm run typecheck` — **clean** (strict + `noUncheckedIndexedAccess`).
- `npm run build` (`wrangler deploy --dry-run`) — bundles for `workerd` at
  **~290 KB gzip** (well under the Free 3 MB limit).
- `wrangler dev` end-to-end (`test/smoke-tx.mjs`): `eth_chainId`/`net_version`,
  the discovery sentinel (encode + decode), overlay-miss **fall-through reads**,
  **`eth_sendRawTransaction`** (EVM executes in the DO), the **sandbox receipt**,
  **sticky overlay** writes, sender debit + nonce bump, `eth_getLogs` merge (and
  upstream range/error surfacing), and **`fakereum_undoLastTx`** reverse-diff
  rewind. This confirms EthereumJS genuinely runs the EVM inside `workerd`.

**Not yet exercised** (implemented + typechecked, but unverified at runtime — test
before relying on them):

- Production **deploy** to your own account (local `workerd` is close but not
  identical); impersonation NAT, Etherscan `/api` merge, WS `eth_subscribe`,
  `eth_call` local `getStorageAt` mode, contract deploys / complex calls, and the
  EIP-712 admin flows.
- **Explorer ABI decoding** shows raw calldata/logs for now — `src/ui/decode.ts`
  is wired and ready, but no on-chain ABI fetcher (Etherscan `getabi` + cache)
  is hooked up yet, so decoded views need that follow-up.
- **Upstream WebSocket push** is not bridged: `eth_subscribe` serves only
  sandbox-driven `newHeads`/`logs` (matching the Go behavior against an
  HTTP-only upstream).
- **`getStorageAt` mode** can exceed the Free 50-subrequest cap on heavy calls;
  keep the default `stateOverride` mode unless on Paid.
- **Per-tx state diff fidelity** (the contract `undo` relies on) follows
  `state_diff.go`, but the selfdestruct-detection path keys off
  `StateManager.deleteAccount`, which can also fire on EIP-158 empty-account
  pruning — verify undo on selfdestruct-heavy txs.

See [`../fakereum/README.md`](../fakereum/README.md) for the full semantics
(overlay fall-through, replay guard, impersonation NAT, state conflicts).
