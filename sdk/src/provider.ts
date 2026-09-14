// createSandboxProvider: an EIP-1193 provider that puts a dapp on a Fakereum
// sandbox while the user's wallet stays whatever it is.
//
//   reads / calls / receipts / logs   -> the sandbox RPC (over HTTP)
//   accounts, personal_sign, wallet_* -> the wallet
//   eth_sendTransaction               -> a signed-message tx (fakereum_transactionMessage
//                                        -> personal_sign -> fakereum_sendTransaction), or the
//                                        wallet itself when the wallet is already on this
//                                        sandbox and the account is of the 'sandbox' kind
//   eth_signTypedData*, eth_sign      -> the wallet, unless the account is of the
//                                        'upstream' kind — then refused (code 4100), because
//                                        with a shared chain id that signature replays upstream
//
// Account kinds come from fakereum_accountKind and are cached per address: an
// entry is refreshed on accountsChanged (and after a send) until the sandbox
// reports it pinned, after which it is frozen for the life of the provider.

import { discover, type Infos } from './discover'
import { ProviderRpcError, rpc, type EIP1193Provider, type RequestArguments } from './rpc'
import { accountKind, sendTransaction, transactionMessage, type AccountKindInfo, type TxRequest } from './sandbox'
import type { Hex } from './hex'

export type SendMode = 'auto' | 'message' | 'wallet'

export interface SandboxProviderOptions {
  /** The sandbox: its RPC URL, or the infos from discover(). */
  sandbox: string | Infos
  /** The user's wallet (window.ethereum, a WalletConnect provider, …). */
  wallet: EIP1193Provider
  /**
   * How eth_sendTransaction travels for 'sandbox'-kind accounts:
   *  'auto'    (default) probe once whether the wallet's own RPC is this sandbox; if so the
   *            wallet sends normally, otherwise everything goes as a signed message
   *  'message' always signed messages
   *  'wallet'  always the wallet (only correct when the wallet is repointed to the sandbox)
   * 'upstream'-kind accounts always send signed messages.
   */
  sendMode?: SendMode
}

export interface SandboxProvider extends EIP1193Provider {
  readonly isFakereum: true
  /** The sandbox RPC URL requests are routed to. */
  readonly rpcUrl: string
  /** Resolve the sandbox's discovery payload (cached). */
  infos(): Promise<Infos>
  /** The (cached) kind of an account; pinned entries never refetch. */
  kind(address: string): Promise<AccountKindInfo>
  /** Drop cached, unpinned kinds so the next lookup refetches. */
  refreshKinds(): void
}

/** Methods that only the wallet can answer. Everything else is state and goes to the sandbox. */
const WALLET_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_coinbase',
  'personal_sign',
  'personal_ecRecover',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_watchAsset',
  'wallet_requestPermissions',
  'wallet_getPermissions',
  'wallet_revokePermissions',
  'wallet_registerOnboarding',
  'wallet_scanQRCode',
  'wallet_getCapabilities',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
  'wallet_showCallsStatus',
])

/** Signature requests that replay upstream when the account is funded there. */
const TYPED_DATA_METHODS = new Set(['eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sign'])

const lower = (a: string): string => a.toLowerCase()

export function createSandboxProvider(opts: SandboxProviderOptions): SandboxProvider {
  const { wallet } = opts
  const sendMode: SendMode = opts.sendMode ?? 'auto'
  const rpcUrl = typeof opts.sandbox === 'string' ? opts.sandbox : opts.sandbox.rpc!
  if (!rpcUrl) throw new Error('createSandboxProvider: sandbox infos carry no rpc URL')

  let infosPromise: Promise<Infos> | null = typeof opts.sandbox === 'string' ? null : Promise.resolve(opts.sandbox)
  const infos = (): Promise<Infos> =>
    (infosPromise ??= discover(rpcUrl).then((i) => {
      if (!i) throw new ProviderRpcError(-32603, `${rpcUrl} is not a Fakereum sandbox`)
      return i
    }))

  // --- account kinds -------------------------------------------------------
  const kinds = new Map<string, AccountKindInfo>()
  const inflight = new Map<string, Promise<AccountKindInfo>>()
  const kind = async (address: string): Promise<AccountKindInfo> => {
    const key = lower(address)
    const cached = kinds.get(key)
    if (cached) return cached
    let p = inflight.get(key)
    if (!p) {
      p = accountKind(rpcUrl, address).then((k) => {
        kinds.set(key, k)
        return k
      })
      inflight.set(key, p)
      p.finally(() => inflight.delete(key)).catch(() => {})
    }
    return p
  }
  const refreshKinds = (): void => {
    for (const [k, v] of kinds) if (!v.pinned) kinds.delete(k)
  }
  /** After a landed write the sandbox has pinned the account: refetch once so the cache freezes. */
  const repin = (address: string): void => {
    const key = lower(address)
    if (kinds.get(key)?.pinned) return
    kinds.delete(key)
    kind(address).catch(() => {})
  }

  // --- where the wallet lives ----------------------------------------------
  let walletOnSandbox: Promise<boolean> | null = null
  const walletIsThisSandbox = (): Promise<boolean> =>
    (walletOnSandbox ??= (async () => {
      const [mine, theirs] = await Promise.all([infos(), discover(wallet)])
      return !!theirs && theirs.chainId === mine.chainId && theirs.networkName === mine.networkName && theirs.rpc === mine.rpc
    })().catch(() => false))

  const accounts = async (): Promise<string[]> => (await wallet.request({ method: 'eth_accounts' })) as string[]

  // --- eth_sendTransaction ---------------------------------------------------
  const sendViaMessage = async (tx: TxRequest, from: string): Promise<Hex> => {
    const { message, nonce } = await transactionMessage(rpcUrl, { ...tx, from })
    const signature = (await wallet.request({ method: 'personal_sign', params: [message, from] })) as string
    const { from: _from, ...rest } = tx
    const hash = await sendTransaction(rpcUrl, { ...rest, nonce, signature })
    repin(from)
    return hash
  }

  const handleSend = async (params: unknown[] | undefined): Promise<unknown> => {
    const tx = (Array.isArray(params) ? params[0] : undefined) as TxRequest | undefined
    if (!tx || typeof tx !== 'object') throw new ProviderRpcError(-32602, 'eth_sendTransaction: expected [tx]')
    const from = tx.from ?? (await accounts())[0]
    if (!from) throw new ProviderRpcError(4100, 'eth_sendTransaction: no account connected')
    const k = await kind(from)
    if (k.kind === 'upstream' || sendMode === 'message') return sendViaMessage(tx, from)
    if (sendMode === 'wallet' || (await walletIsThisSandbox())) {
      const hash = await wallet.request({ method: 'eth_sendTransaction', params: [tx] })
      repin(from)
      return hash
    }
    return sendViaMessage(tx, from)
  }

  const guardTypedData = async (method: string, params: unknown[] | undefined): Promise<void> => {
    // eth_signTypedData* take [address, typedData] (v1 took [typedData, address]); eth_sign takes [address, hash]
    const p = Array.isArray(params) ? params : []
    const candidate = [p[0], p[1]].find((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x)) as string | undefined
    const from = candidate ?? (await accounts())[0]
    if (!from) return
    const k = await kind(from)
    if (k.kind === 'upstream') {
      throw new ProviderRpcError(
        4100,
        `${method} is disabled on this Fakereum sandbox for ${from}: the account holds native token on the real chain, and a typed-data signature made here would be valid there too. Use a transaction (sent as a signed message) instead.`,
      )
    }
  }

  // --- the provider ----------------------------------------------------------
  const request = async (args: RequestArguments): Promise<unknown> => {
    const { method } = args
    const params = Array.isArray(args.params) ? args.params : args.params === undefined ? undefined : [args.params]
    if (method === 'eth_sendTransaction') return handleSend(params)
    if (TYPED_DATA_METHODS.has(method)) {
      await guardTypedData(method, params)
      return wallet.request(args)
    }
    if (WALLET_METHODS.has(method) || method.startsWith('wallet_')) return wallet.request(args)
    return rpc(rpcUrl, method, params ?? [])
  }

  const onAccountsChanged = (): void => refreshKinds()
  const onChainChanged = (): void => {
    walletOnSandbox = null
  }
  wallet.on?.('accountsChanged', onAccountsChanged)
  wallet.on?.('chainChanged', onChainChanged)

  const provider: SandboxProvider = {
    isFakereum: true,
    rpcUrl,
    request,
    infos,
    kind,
    refreshKinds,
    on: (event, listener) => wallet.on?.(event, listener),
    removeListener: (event, listener) => wallet.removeListener?.(event, listener),
  }
  return provider
}
