# fakereum-sdk

Client SDK for [Fakereum](https://github.com/Zergity/fakereum.js) forked-EVM
sandboxes. Framework-agnostic, one small dependency (`@noble/hashes` for
keccak). It covers the four things a dapp needs to run on a sandbox while the
user keeps a normal wallet:

- `discover(target)` — read a sandbox's endpoints from the sentinel, through a
  URL or a wallet provider; `null` for a real chain.
- `accountKind(rpc, address)` — `upstream` (funded on the real chain: signed-message
  transactions only, never EIP-712) or `sandbox`, plus whether it is pinned.
- `transactionMessage()` / `sendTransaction()` — thin POST helpers for the
  EIP-191 signed-message transaction, and `buildTransactionMessage()` to build the
  exact text offline (also `buildImportMessage()` and the `import*` helpers).
- `createSandboxProvider({ sandbox, wallet })` — an EIP-1193 provider that puts
  the dapp on the sandbox: state reads go to the sandbox RPC, accounts and
  `personal_sign` go to the wallet, `eth_sendTransaction` becomes a signed-message
  transaction (or the wallet's own send when the wallet is already on this
  sandbox and the account is of the `sandbox` kind), and typed-data signature
  requests are refused for `upstream` accounts. Kinds are cached per address,
  refreshed on `accountsChanged`, and frozen once the sandbox reports them pinned.
  Signed-message sends are ordered per account so two of them never sign the same
  nonce.

## One line per stack

```ts
import { createSandboxProvider } from 'fakereum-sdk'

const provider = createSandboxProvider({
  sandbox: 'https://fakereum-42161.derion.io/rpc', // or the infos from discover()
  wallet: window.ethereum,
})
```

| stack | wiring |
|---|---|
| ethers v5 | `new ethers.providers.Web3Provider(provider)` |
| ethers v6 | `new ethers.BrowserProvider(provider)` |
| viem | `createWalletClient({ transport: custom(provider) })` |
| wagmi | hand `provider` to your connector's provider override (e.g. `injected({ target: { id: 'fakereum', name: 'Fakereum', provider } })`) |

Anything that patches or logs the provider above the wrapper keeps working: the
wrapper is just another EIP-1193 provider.

## Send-mode

`createSandboxProvider` decides once how a `sandbox`-kind account's
`eth_sendTransaction` travels:

- the wallet's own RPC is **not** this sandbox (a normal MetaMask on Arbitrum)
  → every send is a signed message, because the wallet's `eth_sendTransaction`
  would broadcast to the real chain;
- the wallet **is** on this sandbox (the user repointed its RPC) → the wallet
  sends normally.

`upstream`-kind accounts always send signed messages. Force either behavior
with `sendMode: 'message' | 'wallet'`.

## Nonces

A sandbox has no mempool: `fakereum_sendTransaction` executes on arrival and the
signed nonce has to equal the account's current one. Since signing is a human
round trip, two sends fired together — approve, then swap — would both read the
same nonce while the first prompt is still open, and whichever landed second
would be rejected for reusing it.

`createSandboxProvider` runs an account's sends through two stages:

- **sign** — one at a time, on `max(the nonce the sandbox reports, one past the
  highest nonce signed here)`. A nonce counts as spent the moment the wallet
  hands back a well-formed signature, not when the transaction lands, so the
  next prompt opens while the previous transaction is still executing.
- **submit** — in signing order, one at a time, since nonce N+1 can't land
  before N does.

Nothing is spent until a signature exists: cancel a prompt, or get a malformed
signature back, and the nonce goes to the next send. Different accounts never
wait on each other, and an explicit `tx.nonce` is passed through untouched.
Sends that go through the wallet keep the wallet's own nonce handling.

The spent count is a hint, not a source of truth — another client, or
`fakereum_clearSandbox`, can move the account, and a submit that fails never
consumed its nonce. Either case drops the hint so the next send re-reads from
the sandbox; `provider.resetNonces(address?)` does it on demand, and a
`fakereum_clearSandbox` sent through the provider clears it automatically.

The cost of signing ahead: if a submit fails, anything already signed behind it
was signed against a nonce that never arrived and has to be signed again. That
is the trade for not making the user wait out each execution before the next
prompt.

## Lower-level helpers

```ts
import { discover, accountKind, createNonceManager, transactionMessage, sendTransaction, buildTransactionMessage } from 'fakereum-sdk'

const infos = await discover('https://fakereum-42161.derion.io/rpc')
const { kind, pinned } = await accountKind(infos.rpc, account)

// Skip the nonce manager only if you know one send is in flight at a time.
const nonces = createNonceManager(infos.rpc)

const hash = await nonces.signAndSend(account, {
  sign: async (nonce) => {
    const { message } = await transactionMessage(infos.rpc, { from: account, to, value, data, nonce })
    // identical to: buildTransactionMessage(infos.upstreamChainName, { nonce, to, value, data })
    return wallet.request({ method: 'personal_sign', params: [message, account] })
  },
  submit: (nonce, signature) => sendTransaction(infos.rpc, { to, value, data, nonce, signature }),
})
```

Pass your own manager to `createSandboxProvider({ ..., nonceManager })` to share
one queue between the provider and code that calls these helpers directly.

The message text, byte for byte:

```
Fakereum Tx #<nonce> on <upstream chain name>   (e.g. "on Arbitrum One")
To: <EIP-55 address>              (or "To: CREATE" for a deploy)
Value: <native units, ≤18 dp>     (only when value > 0)
Data: 0x<4 bytes> and <n> bytes with hash 0x…   (only when data is non-empty)
```

## Build

```
npm run build:sdk      # from the repo root → sdk/dist
```

## Install

Published on npm as `fakereum-sdk`:

```
npm i fakereum-sdk
```

Straight from git (pnpm resolves a sub-directory; the `prepare` script builds `dist` on install):

```
pnpm add github:Zergity/fakereum.js#path:sdk
```

For a local checkout: `npm run build:sdk` at the repo root, then `npm link ./sdk` or a
`file:../fakereum.js/sdk` dependency.
