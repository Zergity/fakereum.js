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
| `/admin` | impersonation + clear-sandbox tools (EIP-712, admin-gated) |

Discovery: `eth_call` to `0x…fa4e` returns the ABI-encoded sandbox info string
(same sentinel as the Go version).

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
