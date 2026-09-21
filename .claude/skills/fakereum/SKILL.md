---
name: fakereum
description: Point dapps, wallets, or blockchain tooling at a Fakereum forked-EVM sandbox, and send transactions on one. The main send path is the EIP-191 signed-message transaction (fakereum_transactionMessage -> personal_sign -> fakereum_sendTransaction), which works from a wallet on any chain and is the only path allowed for accounts funded on the real chain. Use when overriding a project's RPC endpoint or Etherscan getLogs API to a Fakereum instance, when detecting a sandbox and reading its rpc/etherscan endpoints via an eth_call to the discovery sentinel (0x…fa4e), or when wiring a dapp's send flow. Covers the live sandboxes at fakereum-42161.derion.io (Arbitrum One), fakereum-4663.derion.io (Robinhood Chain) and fakereum-43111.derion.io (Hemi), wallet / viem / ethers / foundry setup, the getLogs proxy, the dapp integration flow for a fork-aware dapp with a normal wallet or a wallet repointed to the sandbox (fakereum_accountKind: 'upstream' accounts send signed-message txs only and are never asked for EIP-712 / Permit2; 'sandbox' accounts may sign EIP-712; pinned at the account's first landed tx), and the replay guard on raw transactions.
---

# Fakereum sandbox

Fakereum fronts a real EVM RPC and executes signed transactions **locally** against a
sticky overlay of sandbox writes stacked on the real chain's current state (re-read at
the `latest` block on every request — there is no pinned fork block). Reads merge real chain state with the
sandbox's local diffs, served over both Ethereum JSON-RPC and an Etherscan-v2-compatible
API. Nothing you send ever reaches the real chain — it's a shared, persistent fork you can
mutate freely.

Two things to get right:

1. **Sending.** A transaction is normally an **EIP-191 signed message**: the wallet signs a
   short readable text with `personal_sign` and the sandbox executes a real transaction
   from the recovered signer. The wallet can stay on whatever network it is on, and the
   signature is worthless anywhere else — which is why an account holding real funds may
   only send this way. Raw `eth_sendRawTransaction` also works, but the replay guard
   refuses it from any account funded on the real chain. See *Send a transaction* below.
2. **Reading.** Override two endpoints in whatever tool you already use: the **RPC URL**
   and (for log queries) the **Etherscan API base**. Both are self-describing via an
   on-chain discovery call, so you rarely need to hardcode them.

## Deployments

One sandbox per upstream chain. Each serves `<base>/rpc` (JSON-RPC), `<base>/api` and
`<base>/v2/api` (Etherscan-compatible logs), and an explorer at `<base>/` with `/txs`,
`/accounts`, `/import` and `/admin`.

| fork | base URL | chain id | currency |
|---|---|---|---|
| Fake Arbitrum One | `https://fakereum-42161.derion.io` | `42161` (`0xa4b1`) | `FETH` |
| Fake Robinhood Chain | `https://fakereum-4663.derion.io` | `4663` (`0x1237`) | `FETH` |
| Fake Hemi | `https://fakereum-43111.derion.io` | `43111` (`0xa867`) | `FETH` |

Each chain id deliberately matches the real chain's, which is exactly why the **replay
guard** is on — a raw transaction signed here would also be valid upstream. Signed-message
transactions are the way around that, and the reason they are the default. Examples below
use the Arbitrum fork; nothing here is specific to it.

## Discovery: read a sandbox's endpoints with one eth_call

Wallets refuse to relay custom `fakereum_*` methods but always forward `eth_call`, so a
sandbox advertises itself at a sentinel address. No real chain has code there, and the
calldata is ignored — any `eth_call` to it answers:

```
sentinel = 0x000000000000000000000000000000000000fa4e
```

The return value is a single ABI-encoded `string` holding JSON. Decode the string, then
`JSON.parse`:

```jsonc
{
  "chainId":          "0xa4b1",        // this sandbox
  "upstreamChainId":  "0xa4b1",        // forked chain
  "networkName":      "Fake Arbitrum One",
  "symbol":           "FETH",
  "rpc":              "…/rpc",          // JSON-RPC endpoint  ← override your RPC with this
  "etherscanApi":     "…/api",          // Etherscan v2 proxy ← override your logs API with this
  "etherscanApiV2":   "…/v2/api",       // same proxy, /v2/api path
  "explorer":         "…",              // this sandbox's explorer
  "upstreamRpc":      "https://arbitrum-one-rpc.publicnode.com",  // the real chain ← check upstream balances here
  "upstreamChainName": "Arbitrum One",  // header of every signed message ("Fakereum Tx #n on Arbitrum One")
  "upstreamExplorer": { "name": "Arbiscan", "url": "https://arbiscan.io" }  // optional
}
```

Use this to auto-detect a sandbox from any RPC URL and pull its real endpoints rather than
guessing them. It works against **any** Fakereum deployment, not just the Arbitrum one.

**viem**

```ts
import { createPublicClient, http, decodeAbiParameters, parseAbiParameters } from 'viem'

const client = createPublicClient({ transport: http('https://fakereum-42161.derion.io/rpc') })
const { data } = await client.call({ to: '0x000000000000000000000000000000000000fa4e' })
const [json] = decodeAbiParameters(parseAbiParameters('string'), data!)
const infos = JSON.parse(json)   // → { rpc, etherscanApi, chainId, ... }
```

**ethers v6**

```ts
const provider = new ethers.JsonRpcProvider('https://fakereum-42161.derion.io/rpc')
const raw = await provider.call({ to: '0x000000000000000000000000000000000000fa4e' })
const [json] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], raw)
const infos = JSON.parse(json)
```

**foundry / cast**

```sh
cast abi-decode 'infos()(string)' \
  "$(cast call 0x000000000000000000000000000000000000fa4e \
       --rpc-url https://fakereum-42161.derion.io/rpc)"
```

If you're decoding by hand: it's a plain ABI-encoded `string` — skip the 32-byte offset
word, read the 32-byte length, then that many UTF-8 bytes, then `JSON.parse`.

## Send a transaction — the EIP-191 signed message

This is the main way to send on a sandbox. A transaction arrives as an
**EIP-191 signed message**. `personal_sign` is chain-agnostic and never yields anything a node would accept as
a transaction, so it is safe for accounts that hold real funds upstream and works from a
wallet parked on any network. The signature binds nonce, recipient, value and calldata; gas
limit and fee terms are passed unsigned alongside (it's a test sandbox — defaults are filled
like a wallet would). The sandbox then runs a normal tx from the signer.

```
fakereum_transactionMessage [{ from?, to?, value?, data?, nonce? }]               → { message, nonce }
fakereum_sendTransaction    [{ to?, value?, data?, nonce, gas?, gasPrice? | maxFeePerGas?, maxPriorityFeePerGas?, signature }]
                            → tx hash
```

Both go over plain HTTP to the sandbox's `/rpc` — wallets don't relay `fakereum_*` methods,
so the dapp POSTs them itself and uses the wallet only for `personal_sign`:

```ts
const SANDBOX = 'https://fakereum-42161.derion.io/rpc'
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(SANDBOX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())
  if (r.error) throw new Error(r.error.message)
  return r.result
}

/** Drop-in for eth_sendTransaction on the sandbox. One at a time per account — see nonces below. */
async function send(tx: { to?: string; value?: string; data?: string; gas?: string }) {
  const { message, nonce } = await rpc('fakereum_transactionMessage', [{ from: account, ...tx }])
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] })
  return rpc('fakereum_sendTransaction', [{ ...tx, nonce, signature }]) as Promise<`0x${string}`>
}
```

Or let the SDK do it behind an ordinary EIP-1193 provider (`npm i fakereum-sdk`):

```ts
import { createSandboxProvider } from 'fakereum-sdk'
const provider = createSandboxProvider({ sandbox: SANDBOX, wallet: window.ethereum })
const signer = await new ethers.BrowserProvider(provider).getSigner()
await signer.sendTransaction({ to, value })     // travels as a signed message
```

**Nonces.** There is no mempool: the signed nonce must equal the account's nonce when the send
arrives. Two calls started together both read the same nonce while the first prompt is open, and
whichever lands second is refused. Sign one at a time per account, counting a nonce as spent once
a well-formed signature comes back (not when the tx lands), and POST in that order — or use
`createNonceManager()` from the SDK, which does exactly that. A cancelled prompt spends nothing.

The text the user sees in the wallet, byte for byte (`\n`-joined, no trailing newline; the
header uses the nonce and `infos.upstreamChainName` — the real chain's name, never "Fake …" — so
you can also build it yourself):

```
Fakereum Tx #13 on Arbitrum One
To: 0xAb58…eC9B                                  ← EIP-55 checksummed; "To: CREATE" for a deploy
Value: 0.001                                     ← only when value > 0
Data: 0xa9059cbb and 64 bytes with hash 0x…      ← only when data is non-empty
```

Rules that bite:

- **Contract creation works:** omit `to` (or pass `null`) and put the init code in `data`; the
  To line reads `CREATE` and the receipt carries `contractAddress` as usual.

- **`nonce` is required** by `fakereum_sendTransaction` — it is in the header line. Take it
  from the first call's result (or `eth_getTransactionCount`), and don't let two pending sends
  for one account read it at the same time. `gas`, `gasPrice` or
  `maxFeePerGas`/`maxPriorityFeePerGas` are optional, 0x-hex as in `eth_sendTransaction`.
- **It is a real tx.** Nonce must match, and the sender pays `gas * price + value` in FETH
  exactly as with a raw tx (the sandbox lowers its baseFee to your cap if that is below it,
  as it does for raw txs).
- **The hash is a real tx hash.** The sandbox builds the tx with the message signature as its
  v/r/s, so hash and raw bytes look like any tx's; only the sender comes from the message, not
  from what v/r/s recover to. Resubmitting the same signed message fails (stale nonce, or
  `already known` for an identical tx).
- **Not subject to the replay guard** — a signed message can't be broadcast on the real chain,
  which is the whole point of the signed-message path. One that lands is a write, though: it pins the account's
  kind like any tx. Impersonation mapping and the impersonatee guard still apply.
- Receipts and `eth_getTransactionByHash` carry a `signedMessage: {message, signature}`
  field; `/tx/<hash>` shows the signed text above the raw tx.

## Integrate a dapp: make it sandbox-aware

**Shortcut — the SDK.** The repo ships `fakereum-sdk` (`sdk/` in
https://github.com/Zergity/fakereum.js; build with `npm run build:sdk`). It implements every step
below and needs one line per stack:

```ts
import { createSandboxProvider, discover, accountKind } from 'fakereum-sdk'

const provider = createSandboxProvider({ sandbox: 'https://fakereum-42161.derion.io/rpc', wallet: window.ethereum })
// ethers v5: new ethers.providers.Web3Provider(provider)   ethers v6: new ethers.BrowserProvider(provider)
// viem: createWalletClient({ transport: custom(provider) })  wagmi: connector provider override
```

The wrapper routes state reads to the sandbox, sends `eth_sendTransaction` as a signed-message
tx (or through the wallet when the wallet is already on this sandbox and the account is of the
`sandbox` kind), refuses `eth_signTypedData*` / `eth_sign` for `upstream` accounts with error
code 4100, and caches account kinds per address — refreshed on `accountsChanged`, frozen once
pinned. It also orders an account's signed-message sends so two fired together can't sign the
same nonce. `discover()`, `accountKind()`, `transactionMessage()` / `sendTransaction()`, the
offline `buildTransactionMessage()` and `createNonceManager()` are exported for hand-rolled
flows. The rest of this section explains what it does, for dapps that wire things themselves.

There are two ways to put a dapp on a sandbox, and they differ in who knows about the fork.
Pick one deliberately; the send path in step 3 depends on it.

- **Setup A — fork-aware dapp, normal wallet.** The user's wallet (MetaMask, Brave, …) stays on
  the *real* Arbitrum / Robinhood Chain RPC. The dapp is configured with the sandbox and does
  all its reading there. This is the setup for testing with real, funded accounts.
- **Setup B — wallet repointed to the sandbox.** The user has replaced the wallet's RPC for that
  chain with the sandbox's (*Add to wallet* on the landing page). The dapp is unchanged apart
  from detecting where it landed.

In both, the transaction-sending rules of step 3 hinge on the account's kind (`upstream` = holds
native token on the real chain; `sandbox` = empty there), which the sandbox reports and pins —
see step 3.

### 1. Connect through the client wallet

Nothing changes here. The user connects whatever wallet they have.

### 2. Point the dapp at the fork

**Setup A — the dapp knows.** No probing of the wallet's RPC: it is a real chain and answers
nothing at the sentinel. The dapp carries the sandbox base URL in its config (an env var, a
`?sandbox=` query param, a settings toggle) and takes the endpoints from the sentinel *on the
sandbox RPC*, or hardcodes them:

```ts
import { createPublicClient, http, decodeAbiParameters, parseAbiParameters } from 'viem'

const SENTINEL = '0x000000000000000000000000000000000000fa4e'
type Infos = {
  rpc: string; etherscanApi: string; explorer: string; upstreamRpc?: string
  chainId: string; upstreamChainId: string; networkName: string; symbol: string
}

/** Read a sandbox's infos from the sentinel on the given RPC URL; throws on a real chain. */
async function sandboxInfos(rpcUrl: string): Promise<Infos> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const { data } = await client.call({ to: SENTINEL })
  if (!data || data === '0x') throw new Error('not a Fakereum sandbox')   // no code at the sentinel
  const [json] = decodeAbiParameters(parseAbiParameters('string'), data)
  return JSON.parse(json) as Infos
}

const infos = await sandboxInfos(config.sandboxBase + '/rpc')   // e.g. https://fakereum-42161.derion.io/rpc
```

From here on, **every read goes to `infos.rpc`** — balances, `eth_call`, gas estimates,
receipts — and every getLogs to `infos.etherscanApi`. The wallet's provider is used only for
`eth_requestAccounts`, `personal_sign` and (for `sandbox`-kind accounts) `eth_signTypedData_v4`.
Never call `eth_sendTransaction` on it in this setup: it would broadcast to the real chain.
Build a separate viem/ethers client on `infos.rpc` for reads instead of the wallet's provider.

**Setup B — the wallet knows.** Probe the sentinel on the RPC the wallet is connected to; a JSON
payload back means the wallet is on a Fakereum fork, an empty/reverted call means a real chain.
Re-run it whenever the wallet's chain or RPC changes.

```ts
/** Returns sandbox infos if the wallet's RPC is a Fakereum fork, else null. */
async function detectFakereum(walletRpcUrl: string): Promise<Infos | null> {
  try {
    return await sandboxInfos(walletRpcUrl)
  } catch {
    return null                                       // reverted / empty → real chain
  }
}

const infos     = await detectFakereum(walletRpcUrl)
const rpc       = infos?.rpc ?? walletRpcUrl
const logsBase  = infos?.etherscanApi ?? 'https://api.etherscan.io/v2/api'
const isSandbox = infos !== null
```

### 3. When the user sends a transaction

The sandbox shares the real chain's id, so anything the wallet signs as a *transaction* or as
*EIP-712 typed data* (a Permit, a Permit2 batch, an order) is valid on the real chain too. For an
account that holds real native token upstream that is a live replay risk. A `personal_sign`
message is not: it replays nowhere, which is what the signed-message transaction path is built
on. Ask the sandbox which kind the connected account is — don't read upstream balances yourself:

```ts
const sandboxRpc = async (method: string, params: unknown[]) => {
  const r = await fetch(infos.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())
  if (r.error) throw new Error(r.error.message)
  return r.result
}

// On connect (and whenever the connected account changes).
const { kind, pinned } = await sandboxRpc('fakereum_accountKind', [account]) as {
  kind: 'sandbox' | 'upstream'; pinned: boolean
}
```

Reads never pin anything: until the account's first landed sandbox transaction, `kind` follows
its live upstream balance and `pinned` is `false`. That first landed tx pins the verdict for
good — a burner topped up on the real chain later stays `sandbox`, a real account that spends
itself down stays `upstream` — and the replay guard enforces the same verdict, so what the dapp
is told and what the sandbox does always agree. A `pinned: true` answer can be cached for the
session. (`fakereum_*` methods go over plain HTTP to `infos.rpc`; wallets don't relay them. With
the replay guard off, i.e. a sandbox on its own chain id, every account is `sandbox`.)

**The signed-message send** — used by every account in setup A, and by `upstream` accounts in
setup B. Ask the sandbox for the text, have the wallet `personal_sign` it, POST fields plus
signature to `infos.rpc`; the tx lands as a normal sandbox transaction from `account` (real
nonce, gas and fee, real tx hash) and you poll its receipt on `infos.rpc` as usual:

```ts
/** Drop-in for eth_sendTransaction on the sandbox. One at a time — see the nonce note below. */
async function sendViaSignedMessage(tx: { to: string; value?: string; data?: string; gas?: string }) {
  const { message, nonce } = await sandboxRpc('fakereum_transactionMessage', [{ from: account, ...tx }])
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] })
  return sandboxRpc('fakereum_sendTransaction', [{ ...tx, nonce, signature }]) as Promise<`0x${string}`>
}
```

One at a time per account — the nonce rule and the full message format are in
*Send a transaction* above.

**3a. `kind === 'upstream'` → signed messages only, and never EIP-712.** In both setups every
send goes through `sendViaSignedMessage`. Funding is not an issue: the account already holds
1000× its real balance in FETH here (see *Balances* below). Never ask this account to sign a transaction or any
EIP-712 typed data — Permit / Permit2 included — while it is on the sandbox; those signatures
replay upstream. Where your flow would collect a permit signature, use the approval-transaction
fallback (an `approve` through `sendViaSignedMessage`) or hide that path in sandbox mode. The
replay guard refuses this account's raw transactions for the same reason, but it cannot see
typed-data signatures — the dapp has to hold that line itself.

**3b. `kind === 'sandbox'` → EIP-712 is fine; how the tx travels depends on the setup.**
Permit / Permit2 / order signatures may be requested as on the real chain: an empty account
has nothing to lose to a replay. The transaction that uses them:

- *Setup A:* still `sendViaSignedMessage` — the wallet's `eth_sendTransaction` would go to the
  real chain. The kind changes nothing about sending here; it only unlocks EIP-712.
- *Setup B:* `eth_sendTransaction` through the wallet, exactly as before — the wallet's RPC is
  the sandbox, which executes it locally.

Either way the account needs FETH inside the fork to pay for gas — an empty burner has none, so
import a balance from another chain (`/import`, see *Balances* below) or receive a transfer.
Because the kind is pinned, no later upstream deposit turns this account back into 3a.

Gotchas that remain either way:

- **The logs proxy is getLogs-only.** Repoint *only* your getLogs calls at
  `infos.etherscanApi`; leave `getabi`/`txlist`/`tokentx`/verification on the real explorer
  — they aren't proxied. `apikey` is still required and forwarded upstream, so keep passing
  your real key.
- Ask `fakereum_accountKind` again when the connected account changes (a fresh burner is its
  own account with its own verdict).

## Balances: 1000× upstream, and importing from another chain

Nobody needs a faucet. An account that has never transacted on the sandbox is shown holding
**1000× its native balance on the upstream chain** (`eth_getBalance`, what a tx can spend,
what forwarded `eth_call` / `eth_estimateGas` see for `from`). Once its first sandbox tx lands
the sandbox tracks the balance itself and upstream stops mattering. So an `upstream`-kind
account (real ETH on Arbitrum) arrives with 1000× that in FETH and can pay gas and value
straight away through signed messages; an empty burner arrives with nothing.

Funds on **another** chain can be brought in once per account at `<base>/import`
(Ethereum Mainnet, Arbitrum One, Base, Hemi, Robinhood Chain — minus the sandbox's own upstream,
which is automatic). The page lists the account's balance on each source; the user picks one
and `personal_sign`s

```
Fakereum Import to Arbitrum One
Account: 0xAb58…eC9B
From: Ethereum Mainnet (chain id 1)
```

and the sandbox credits `balance × 1000` FETH on top of what the account shows now. One import
per account, from one chain, ever — it survives `fakereum_clearSandbox`; a zero balance or a
failed read does not consume it. From a dapp, the same three calls go over HTTP to `infos.rpc`:
`fakereum_importSources [address]`, `fakereum_importMessage [{account, chainId}]`,
`fakereum_importBalance [{account, chainId, signature}]`. Importing pins the account's kind
like a landed tx.

## Override the RPC endpoint

Everything except the local-execution behavior is standard JSON-RPC, so point your existing
config at `…/rpc`. This is for **reads** and for key-holding scripts; a dapp's user does not
need any of it, because signed-message sends work from an untouched wallet.

**Wallet (optional)** — open the sandbox's landing page and click *Add to wallet*, or call
`wallet_addEthereumChain` with `rpcUrls: ['https://fakereum-42161.derion.io/rpc']`,
`chainId: '0xa4b1'`, `nativeCurrency.symbol: 'FETH'`. (Because the chain id equals real
Arbitrum, a wallet already on Arbitrum only needs its RPC URL repointed.) A repointed wallet
can `eth_sendTransaction` straight to the sandbox — but only from an account that is empty on
the real chain; anything else still has to go through the signed-message path.

**viem / wagmi**

```ts
import { defineChain, createPublicClient, http } from 'viem'

const fakeArbitrum = defineChain({
  id: 42161,
  name: 'Fake Arbitrum One',
  nativeCurrency: { name: 'FETH', symbol: 'FETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://fakereum-42161.derion.io/rpc'] } },
})

const client = createPublicClient({ chain: fakeArbitrum, transport: http() })
```

**ethers** — `new ethers.JsonRpcProvider('https://fakereum-42161.derion.io/rpc', 42161)`

**foundry** — add `--rpc-url https://fakereum-42161.derion.io/rpc` to `cast` / `forge script`
/ `forge create`. Reads see the merged fork state; broadcasts stay in the sandbox.

## Override the Etherscan API — logs only

The `/api` and `/v2/api` paths are an Etherscan **v2**-compatible proxy, but **only
`module=logs&action=getLogs` is implemented.** It forwards to the upstream explorer and
merges this sandbox's local logs into the result, so log-indexing tooling sees sandbox
events alongside real ones. Point your tool's Etherscan base URL at `…/api` (or `/v2/api`)
for log reads:

```sh
curl 'https://fakereum-42161.derion.io/v2/api?module=logs&action=getLogs\
&address=0xYourContract&fromBlock=0&toBlock=latest\
&topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef\
&apikey=YOUR_ETHERSCAN_KEY'
```

Details that matter:

- **`apikey` is required** on a sandbox whose upstream explorer is Etherscan (the Arbitrum
  one) and is forwarded upstream as-is — use your own real Etherscan v2 key. A sandbox fronting
  a Blockscout explorer (the Robinhood Chain one) fills in the operator's key when you send
  none.
- **`chainid` is forced** to the upstream chain id server-side. You can send the sandbox's
  chain id (tools parrot it back); it gets replaced with the real one before the upstream
  call, so you don't have to special-case it.
- `fromBlock`/`toBlock` accept bare decimals (normalized to hex for you) or `latest` etc.
- Do **not** expect `getabi`, `txlist`, `tokentx`, contract verification, or any non-logs
  module to work here — they aren't proxied. Keep those pointed at the real explorer.

## Replay guard — why raw transactions are the restricted path

Because the sandbox shares the real chain's id, a *raw* transaction signed here would also be
valid upstream, so it could be replayed for real. That is the whole reason the signed-message
path exists and is the default. The guard enforces it: `eth_sendRawTransaction` is
**rejected if the signer is of the `upstream` kind** — it held native balance on the real
chain at its first landed sandbox transaction (`fakereum_accountKind`; the verdict is pinned
then and never re-read). Such an account sends signed messages instead (step 3a above), which
are exempt: a `personal_sign` message is not a broadcastable transaction.

The same reasoning is why a dapp must not request EIP-712 signatures (Permit, Permit2, orders)
from that account while on the sandbox — the guard cannot see those, and they replay upstream
just as a raw tx would.

So: use signed messages, or sign raw transactions only from a wallet that is empty on the real
chain and funded with FETH inside the sandbox. A zero-real-balance account qualifies even if it
has nonce or code upstream — the check keys on balance only — and once pinned `sandbox` it
stays so.

## Run your own sandbox

Fakereum is open source and self-hostable — anyone can stand one up on Cloudflare's **free
tier**: one Worker per chain, hosting the EVM Durable Object (it gets the 30s CPU budget
the EVM needs) and carrying the public hostname as a custom domain, which Cloudflare
provisions at deploy time. Each deployment forks a single upstream
chain and runs under its own **chain id** — set `CHAIN_ID` explicitly, or leave it `0` to
auto-derive `420<upstreamId>` (e.g. Ethereum mainnet → `4201`). You can also reuse the real
chain id, as the Arbitrum instance does (`42161`), so wallets need no network switch — that
mode turns the replay guard on.

So `fakereum-42161.derion.io` is just one instance. Point the same discovery call and
endpoint overrides above at whatever base URL a sandbox is served from; nothing here is
specific to the Arbitrum deployment. Deploy steps are in the repo README.

## Good to know

- **Sending, in one line:** `fakereum_transactionMessage` → `personal_sign` →
  `fakereum_sendTransaction`, POSTed to the sandbox's `/rpc`. Raw `eth_sendRawTransaction`
  only from accounts empty on the real chain.
- **One sandbox per deployment** (one upstream → one sandbox chain id); state is shared and
  persistent across everyone hitting it.
- Balances: 1000× the upstream balance until an account's first sandbox tx; `/import` brings
  funds from another chain once per account (see above).
- On the current Free-plan hosting, external subrequests are capped, so a pathological
  transaction touching a large cold-state graph can fail with "Too many subrequests." Normal
  transfers and moderate contract calls are fine.
- `eth_subscribe` serves sandbox-driven `newHeads`/`logs` only (upstream push isn't bridged).
- Source: https://github.com/Zergity/fakereum.js
