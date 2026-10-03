---
name: fakereum-btc
description: Point a Bitcoin app, wallet library or tooling at a Fakereum BTC sandbox - a UTXO sandbox that serves an Esplora REST API (/api) and a bitcoind JSON-RPC subset (/rpc), mints test coins with fakereum_faucet, mines blocks with fakereum_mine, and accepts ordinary signed transactions. Use when switching an Esplora or bitcoind client (BDK, esplora-client, mempool.js, bitcoinjs-lib flows, curl) to a sandbox, when detecting one via GET /fakereum, when funding test wallets, when waiting on confirmations in a test, or when a broadcast is rejected (bad-txns-inputs-missingorspent, mandatory-script-verify-flag-failed, min relay fee not met, non-final). Covers what the sandbox verifies (P2PKH, P2WPKH, P2SH-P2WPKH, taproot key path), how real mainnet outputs are spent (BIP-322 signed message or impersonator, never a raw signature), the admin RPCs and explorer pages, and what it does not do (Electrum protocol, P2WSH / multisig / script-path, BIP68). For the EVM sandboxes use the fakereum skill instead.
---

# Fakereum BTC sandbox

A Bitcoin sandbox from the same repo as the EVM Fakereum, deployed as its own Worker
(`[env.btc]` in `wrangler.toml`, Durable Object class `BtcSandbox`, code in `src/btc/`).
It keeps a set of unspent outputs and its own timeline of synthetic blocks. Every accepted
transaction is mined at once into a block of its own. Nothing reaches the real network.

**Status:** live at `https://btc.derion.io` (Worker `fakereum-btc-rpc`; the custom domain was
attached by hand with `--domain btc.derion.io`, not the script's `fakereum-btc.…` default).
You can also run it locally (below). The explorer UI follows the mempool.space design handoff.

Throughout, `$BASE` is the sandbox's base URL.

## Run it locally

```
npx wrangler dev --env btc --var UPSTREAM_ESPLORA: --port 8799 --persist-to /some/scratch/dir
# BASE=http://localhost:8799
```

The empty `UPSTREAM_ESPLORA` makes it a standalone chain that starts empty at height 0
and never touches the network. Leave the var as configured to fork from mempool.space /
blockstream.info instead. When you stop it, kill the exact PID you started, not
`pkill workerd` (other dev servers may be running).

## Detect it

`GET $BASE/fakereum` returns:

```json
{ "fakereum": true, "kind": "btc", "network": "mainnet",
  "esplora": "$BASE/api", "rpc": "$BASE/rpc",
  "forked": false, "forkHeight": 0, "forkHash": "…", "tip": { "height": 0, "hash": "…", "time": 0 },
  "faucetMaxSats": "10000000000" }
```

`kind: "btc"` tells it apart from an EVM sandbox. `getblockchaininfo` also carries
`fakereum: true`.

## Point a client at it

| the app uses | base URL |
|---|---|
| an Esplora client | `$BASE/api` |
| a bitcoind JSON-RPC client | `$BASE/rpc` (no auth) |

Addresses keep the real network's prefixes (`BTC_NETWORK`, default mainnet), so existing
address handling needs no change.

## Fund a wallet

```
curl -s $BASE/rpc -d '{"jsonrpc":"2.0","id":1,"method":"fakereum_faucet","params":["<address>", 100000000]}'
```

`params` is `[address, satoshis]`; the amount must be a whole number between 1 and
`FAUCET_MAX_SATS` (default 100 BTC). The result is the txid. The faucet is open.

## Spend and confirm

1. UTXOs: `GET /api/address/<addr>/utxo` (also `/api/scripthash/<hash>/utxo`).
2. Build and sign with the app's own key as usual.
3. Broadcast: `POST /api/tx` with the raw hex as the body, or `sendrawtransaction`. Dry run
   with `testmempoolaccept`.
4. It is confirmed immediately: `GET /api/tx/<txid>/status`.
5. For N confirmations call `fakereum_mine [n]` (1 to 1000 empty blocks).

Other Esplora routes: `/api/address/<a>` (stats), `/api/address/<a>/txs`, `/api/tx/<id>`,
`/tx/<id>/hex`, `/tx/<id>/outspend/<vout>`, `/api/block/<hash>`, `/api/block-height/<h>`,
`/api/blocks/tip/height`, `/api/blocks/tip/hash`, `/api/fee-estimates`.
bitcoind RPC: `getblockchaininfo`, `getblockcount`, `getbestblockhash`, `getblockhash`,
`getblock` (sandbox blocks), `getrawtransaction`, `sendrawtransaction`,
`testmempoolaccept`, `estimatesmartfee`, `getmempoolinfo`, `getrawmempool`.

## What it checks, and what it rejects

A broadcast is checked for: valid encoding, no duplicate or missing inputs, values in
range, outputs not above inputs, `nLockTime` finality (height or median time past), a
minimum relay feerate (`MIN_RELAY_FEE_SAT_KVB`, default 1 sat/vB), and a valid signature on
every input. A failure over REST is HTTP 400 with
`sendrawtransaction RPC error: {"code":-26,"message":"<reason>"}`.

| reason | meaning / fix |
|---|---|
| `bad-txns-inputs-missingorspent` … `real chain` | the input is not an output of this sandbox. Real mainnet outputs cannot be spent here (below). Fund the address with the faucet instead |
| `bad-txns-inputs-missingorspent` … `already spent` | double spend |
| `mandatory-script-verify-flag-failed (input N: …)` | bad signature, wrong key, wrong amount signed, or an unsupported input type (named in the message) |
| `min relay fee not met` | raise the fee |
| `bad-txns-in-belowout` | outputs exceed inputs |
| `non-final` | `nLockTime` not reached; `fakereum_mine` to advance, or wait for time-based locks |
| `txn-already-known` | already broadcast |

Signature checking is not a script interpreter. Verified: P2PKH, P2WPKH, P2SH-P2WPKH and
taproot key-path. Rejected by name: P2WSH, multisig, taproot script path, arbitrary
scripts. BIP68 relative locktimes are not enforced.

## Real outputs: signed message or impersonator

A Bitcoin transaction carries no chain id, so an ordinary signed spend of a real output
would also be valid on the real chain. The sandbox therefore refuses it
(`spending a real output needs fakereum_sendTransaction …`). Two replay-safe ways in:

**Signed message** (the BTC counterpart of the EVM EIP-191 path). The owner signs a text
that describes the whole transaction; a message signature cannot be turned into a spend.
1. Build the transaction with the real inputs and *empty* witnesses/scriptSigs (inputs
   that are sandbox coins carry their own signatures as usual).
2. `fakereum_transactionMessage [unsignedHex]` returns `{message, id, signers, fee}`.
3. Each address in `signers` signs `message` with BIP-322 simple (P2WPKH, P2SH-P2WPKH or
   P2TR; legacy P2PKH cannot). Wallet `signMessage` calls with `bip322-simple` do this.
4. `fakereum_sendTransaction [{tx: unsignedHex, signatures: [{address, signature}]}]`
   returns the txid. The signature is the base64 witness, as wallets return it.

Real outputs must be unspent on the real chain; their value inside the sandbox is the real
value times `BALANCE_MULTIPLIER` (default 1). Real address stats and UTXO lists show the
scaled values; real transaction history is untouched.

**Impersonation.** An admin maps `impersonator -> impersonatee`; a signature by the
impersonator then spends the impersonatee's outputs (real or sandbox) through the ordinary
`sendrawtransaction`. It cannot be replayed: the signature commits to the impersonator's
script. `fakereum_listImpersonators` returns `{impersonatee: [impersonators]}`.

`fakereum_accountKind [address]` returns `{address, kind, pinned, replayGuard}`: `upstream`
if the address has real-chain history (use the signed-message flow), `sandbox` otherwise.
A spend that lands pins the kind.

## Admin and housekeeping RPCs

Admin actions need `ADMINS` (BTC addresses) configured. Each is signed by an admin with
BIP-322: call `fakereum_adminMessage [{action, ...fields}]` for `{message, deadline}`, sign
the message, then call the action with `[{...fields, admin, signature, deadline}]`. A
signature is good for 10 minutes by default, once, for that action only.

| method | fields | effect |
|---|---|---|
| `fakereum_setImpersonator` | impersonator, impersonatee | allow the signer to spend for the other address |
| `fakereum_removeImpersonator` | impersonator | undo that |
| `fakereum_setUiMode` | upstream (bool) | explorer drops sandbox wording, faucet, accounts, admin |
| `fakereum_clearSandbox` | none | drop every sandbox block and tx, re-apply `GENESIS` |

Unsigned, like the EVM sandbox: `fakereum_undoLastTx` (returns the removed txid or null)
and `fakereum_undoBackTo [txid]` (removes that tx and everything after, newest first).
Empty `fakereum_mine` blocks after the last tx go with the undone block.

## Explorer pages

`/` dashboard (blocks, fees, recent txs, faucet), `/block/<hash>`, `/block-height/<n>`,
`/tx/<id>`, `/address/<a>`, `/search?q=`, `/txs` (sandbox txs with undo buttons),
`/accounts`, `/admin` (connect Unisat or paste a signature). `UI_MODE=upstream` or
`fakereum_setUiMode` hides the sandbox-only parts.

## Limits worth knowing

- No Electrum protocol. Sparrow, Electrum and wallets that need an Electrum server cannot
  connect. Browser wallets with their own backends cannot be repointed.
- When forked, the timeline starts at the upstream tip seen on the first request, then
  diverges. Block heights above that point are the sandbox's, not the real chain's.
- Reads of the real chain use the upstream's current tip, not the fork height.
- It has been exercised with `fetch` and a test signer, not yet with BDK, bitcoinjs-lib or
  other client libraries; if one misbehaves, compare its requests with the routes above.

Config knobs (`wrangler.toml` `[env.btc.vars]`): `BTC_NETWORK`, `UPSTREAM_ESPLORA`,
`FAUCET_MAX_SATS`, `MIN_RELAY_FEE_SAT_KVB`, `FEE_RATE_SAT_VB`, `ADMINS`, `IMPERSONATE`
(`impersonator:impersonatee,…`), `GENESIS` (`{"alloc":{"<addr>":{"balance":"<sats>"}}}`),
`BALANCE_MULTIPLIER`, `UI_MODE`, plus `RATE_LIMIT_RPS`,
`RATE_LIMIT_EXEMPT`, `CORS_ORIGINS`, `UPSTREAM_TIMEOUT_MS`. The README's "Bitcoin sandbox"
section has the rest.
