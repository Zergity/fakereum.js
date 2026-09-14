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

## Lower-level helpers

```ts
import { discover, accountKind, transactionMessage, sendTransaction, buildTransactionMessage } from 'fakereum-sdk'

const infos = await discover('https://fakereum-42161.derion.io/rpc')
const { kind, pinned } = await accountKind(infos.rpc, account)

const { message, nonce } = await transactionMessage(infos.rpc, { from: account, to, value, data })
// identical to: buildTransactionMessage(infos.networkName, { nonce, to, value, data })
const signature = await wallet.request({ method: 'personal_sign', params: [message, account] })
const hash = await sendTransaction(infos.rpc, { to, value, data, nonce, signature })
```

The message text, byte for byte:

```
Fakereum Tx #<nonce> on <networkName>
To: <EIP-55 address>              (or "To: new contract" for a deploy)
Value: <native units, ≤18 dp>     (only when value > 0)
Data: 0x<4 bytes> and <n> bytes with hash 0x…   (only when data is non-empty)
```

## Build

```
npm run build:sdk      # from the repo root → sdk/dist
```
