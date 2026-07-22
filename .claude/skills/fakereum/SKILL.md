---
name: fakereum
description: Point dapps, wallets, or blockchain tooling at a Fakereum forked-EVM sandbox. Use when overriding a project's RPC endpoint or Etherscan getLogs API to a Fakereum instance, or when detecting a sandbox and reading its rpc/etherscan endpoints via an eth_call to the discovery sentinel (0x…fa4e). Covers the live Arbitrum sandbox at fakereum-42161.derion.io, wallet / viem / ethers / foundry setup, the getLogs proxy, and the replay guard.
---

# Fakereum sandbox

Fakereum fronts a real EVM RPC and executes signed transactions **locally** against a
sticky state overlay layered on `upstream@latest`. Reads merge real chain state with the
sandbox's local diffs, served over both Ethereum JSON-RPC and an Etherscan-v2-compatible
API. Nothing you send ever reaches the real chain — it's a shared, persistent fork you can
mutate freely.

Practically, using a sandbox means overriding two endpoints in whatever tool you already
use: the **RPC URL** and (for log queries) the **Etherscan API base**. Both are
self-describing via an on-chain discovery call, so you rarely need to hardcode them.

## Live deployment (Arbitrum One fork)

The current instance forks Arbitrum One. Base URL: `https://fakereum-42161.derion.io`

| | |
|---|---|
| Network name | Fake Arbitrum One |
| Chain ID | `42161` (`0xa4b1`) — same as real Arbitrum, so wallets need no re-add |
| Currency | `FETH` |
| RPC | `https://fakereum-42161.derion.io/rpc` |
| Etherscan API | `https://fakereum-42161.derion.io/api` and `/v2/api` |
| Explorer | `https://fakereum-42161.derion.io/` (`/txs`, `/accounts`, `/admin`) |
| Upstream | Arbitrum One via `https://arbitrum-one-rpc.publicnode.com` |

The chain id deliberately matches real Arbitrum, which is exactly why the **replay guard**
below is on — read that before sending transactions.

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

## Integrate a dapp: make it sandbox-aware

You don't need a separate build or a hardcoded sandbox URL. Have the dapp probe the
sentinel against whatever RPC the user is already connected to, and let the answer decide
its config. A JSON payload back means you're on a Fakereum fork; an empty/reverted call
means it's a real chain — fall through to your production endpoints.

The pattern:

1. On connect (and again whenever the wallet's chain or RPC changes), probe the sentinel.
2. If it answers, take your **log source** from `infos.etherscanApi` (getLogs only) and keep
   using `infos.rpc` for everything else. Optionally flip on a "sandbox" banner and build
   tx links from `infos.explorer`.
3. If it doesn't, keep your usual RPC + real Etherscan base.

```ts
import { createPublicClient, http, decodeAbiParameters, parseAbiParameters } from 'viem'

const SENTINEL = '0x000000000000000000000000000000000000fa4e'

/** Returns sandbox infos if `rpcUrl` is a Fakereum fork, else null. */
async function detectFakereum(rpcUrl: string) {
  const client = createPublicClient({ transport: http(rpcUrl) })
  try {
    const { data } = await client.call({ to: SENTINEL })
    if (!data || data === '0x') return null          // real chain: no code at the sentinel
    const [json] = decodeAbiParameters(parseAbiParameters('string'), data)
    return JSON.parse(json) as {
      rpc: string; etherscanApi: string; explorer: string
      chainId: string; networkName: string; symbol: string
    }
  } catch {
    return null                                       // reverted → treat as real chain
  }
}

const infos     = await detectFakereum(activeRpcUrl)
const rpc       = infos?.rpc ?? activeRpcUrl
const logsBase  = infos?.etherscanApi ?? 'https://api.etherscan.io/v2/api'
const isSandbox = infos !== null
```

Feed `rpc` to your provider, `logsBase` to whatever runs your getLogs, and gate any
"you're on a test fork" UI on `isSandbox`.

Watch out for:

- **The logs proxy is getLogs-only.** Repoint *only* your getLogs calls at
  `infos.etherscanApi`; leave `getabi`/`txlist`/`tokentx`/verification on the real explorer
  — they aren't proxied. `apikey` is still required and forwarded upstream, so keep passing
  your real key.
- **The signer must be empty on the real chain.** When the sandbox reuses the real chain id
  (the Arbitrum instance does), the replay guard rejects a send from any address holding
  native balance upstream. Steer users to a fresh/burner account for sandbox mode, funded
  with FETH inside the fork.
- **Cache the probe per RPC and re-run it on chain/RPC change** — don't detect once and
  assume it holds for the session.

## Override the RPC endpoint

Everything except the local-execution behavior is standard JSON-RPC, so point your existing
config at `…/rpc`.

**Wallet** — open the sandbox's landing page and click *Add to wallet*, or call
`wallet_addEthereumChain` with `rpcUrls: ['https://fakereum-42161.derion.io/rpc']`,
`chainId: '0xa4b1'`, `nativeCurrency.symbol: 'FETH'`. (Because the chain id equals real
Arbitrum, a wallet already on Arbitrum only needs its RPC URL repointed.)

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

- **`apikey` is required** and forwarded upstream as-is — use your own real Etherscan v2 key.
- **`chainid` is forced** to the upstream chain id server-side. You can send the sandbox's
  chain id (tools parrot it back); it gets replaced with the real one before the upstream
  call, so you don't have to special-case it.
- `fromBlock`/`toBlock` accept bare decimals (normalized to hex for you) or `latest` etc.
- Do **not** expect `getabi`, `txlist`, `tokentx`, contract verification, or any non-logs
  module to work here — they aren't proxied. Keep those pointed at the real explorer.

## Replay guard — which wallet you sign from matters

Because the sandbox shares Arbitrum's chain id, a transaction signed here could in principle
be replayed onto the real chain. The guard blocks that: `eth_sendRawTransaction` is
**rejected if the signer holds any native balance on real Arbitrum.** Sign only from a
wallet that is empty on the real chain (zero upstream balance) and funded with FETH inside
the sandbox. A zero-real-balance account is fine even if it has nonce or code upstream — the
check keys on balance only.

## Run your own sandbox

Fakereum is open source and self-hostable — anyone can stand one up on Cloudflare's **free
tier**: a Worker that hosts the EVM Durable Object (it gets the 30s CPU budget the EVM
needs) plus a Pages project for the public URL. Each deployment forks a single upstream
chain and runs under its own **chain id** — set `CHAIN_ID` explicitly, or leave it `0` to
auto-derive `420<upstreamId>` (e.g. Ethereum mainnet → `4201`). You can also reuse the real
chain id, as the Arbitrum instance does (`42161`), so wallets need no network switch — that
mode turns the replay guard on.

So `fakereum-42161.derion.io` is just one instance. Point the same discovery call and
endpoint overrides above at whatever base URL a sandbox is served from; nothing here is
specific to the Arbitrum deployment. Deploy steps are in the repo README.

## Good to know

- **One sandbox per deployment** (one upstream → one sandbox chain id); state is shared and
  persistent across everyone hitting it.
- On the current Free-plan hosting, external subrequests are capped, so a pathological
  transaction touching a large cold-state graph can fail with "Too many subrequests." Normal
  transfers and moderate contract calls are fine.
- `eth_subscribe` serves sandbox-driven `newHeads`/`logs` only (upstream push isn't bridged).
- Source: https://github.com/Zergity/fakereum
