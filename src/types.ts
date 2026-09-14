// Master shared contract. Every module imports its domain types from here so
// the (hand-written core) and the (parallel-built leaves) agree on shapes.

import type { Hex } from './lib/hex'

// --------------------------------------------------------------------------
// Worker bindings (wrangler [vars] + secrets + the Durable Object namespace).
// --------------------------------------------------------------------------
export interface Env {
  EVM_SANDBOX: DurableObjectNamespace
  UPSTREAM_RPC: string
  UPSTREAM_ETHERSCAN: string
  /** "etherscan" | "blockscout"; unset = sniffed from the UPSTREAM_ETHERSCAN URL. */
  UPSTREAM_ETHERSCAN_STYLE?: string
  /** Secret; comma-separated for rotation. */
  ETHERSCAN_API_KEY?: string
  CHAIN_ID?: string
  SYMBOL?: string
  NETWORK_NAME?: string
  ETH_CALL_STORAGE_MODE?: string
  CACHE_TTL?: string
  REJECT_UPSTREAM_SIGNERS?: string
  ADMINS?: string
  IMPERSONATE?: string
  CORS_ORIGINS?: string
  RATE_LIMIT_RPS?: string
  /** Comma-separated IPs/CIDRs that bypass the per-IP rate limit. */
  RATE_LIMIT_EXEMPT?: string
  GENESIS?: string
  /** Sandbox native balance = upstream balance × this, until the account's own state takes over. Default 1000. */
  BALANCE_MULTIPLIER?: string
}

export type EthCallStorageMode = 'stateOverride' | 'getStorageAt'

/**
 * Upstream explorer API dialect. Etherscan v2 wants 0x-hex getLogs block
 * numbers and needs an apikey; Blockscout's Etherscan-compat endpoint wants
 * bare decimals and takes no key.
 */
export type EtherscanStyle = 'etherscan' | 'blockscout'

// --------------------------------------------------------------------------
// Resolved config. Static fields come from env at construction; chainId/symbol/
// networkName/upstreamChainId are filled once the upstream chain id is known.
// --------------------------------------------------------------------------
export interface Config {
  upstreamRpcs: string[]
  upstreamEtherscan: string
  etherscanStyle: EtherscanStyle
  etherscanKeys: string[]
  /** Sandbox chain id. 0n until resolved (then derived or from CHAIN_ID). */
  chainId: bigint
  /** Discovered from upstream eth_chainId; 0n until resolved. */
  upstreamChainId: bigint
  symbol: string
  networkName: string
  ethCallStorageMode: EthCallStorageMode
  cacheTtlMs: number
  /** null = auto (on iff chainId === upstreamChainId). */
  rejectUpstreamSigners: boolean | null
  admins: Hex[]
  /** Seed pairs [impersonator B, impersonatee A]. */
  impersonateSeed: Array<[Hex, Hex]>
  corsOrigins: string[]
  rateLimitRps: number
  /** IPs/CIDRs exempt from rate limiting. */
  rateLimitExempt: string[]
  genesis: GenesisAlloc | null
  /**
   * Native-balance multiplier applied to every balance the sandbox
   * materializes from upstream (an account not yet holding a sandbox balance
   * shows upstream × this). Once the account's first tx lands, or it imports,
   * the overlay tracks the balance and upstream no longer matters.
   */
  balanceMultiplier: bigint
  resolved: boolean
}

// --------------------------------------------------------------------------
// Genesis alloc (geth-style; fill-only seeding of the overlay).
// --------------------------------------------------------------------------
export interface GenesisAccount {
  balance?: string
  nonce?: string
  code?: string
  storage?: Record<string, string>
}
export interface GenesisAlloc {
  alloc: Record<string, GenesisAccount>
}

// --------------------------------------------------------------------------
// Overlay: the sticky post-state. Persisted one entry per address under
// `overlay:<addrKey>` in DO storage. A field is "set" iff present.
// --------------------------------------------------------------------------
export interface OverlayAccount {
  balance?: Hex // QUANTITY hex
  nonce?: Hex // QUANTITY hex
  code?: Hex
  /** slot (0x-padded-32) -> value (0x-padded-32). */
  storage?: Record<string, Hex>
  /** When true, the account was selfdestructed in the sandbox. */
  selfDestructed?: boolean
}

// --------------------------------------------------------------------------
// Per-tx state diff (state_diff.go). undo replays this in reverse.
// --------------------------------------------------------------------------
export interface StorageChange {
  pre: Hex // 0x-32
  post: Hex // 0x-32
  preOverlaySet: boolean
}

export interface AccountDiff {
  preExists: boolean
  postExists: boolean
  preOverlayExists: boolean

  balanceChanged: boolean
  preBalance?: Hex
  postBalance?: Hex
  balancePreOverlaySet: boolean

  nonceChanged: boolean
  preNonce?: Hex
  postNonce?: Hex
  noncePreOverlaySet: boolean

  codeChanged: boolean
  preCode?: Hex
  postCode?: Hex
  codePreOverlaySet: boolean

  /** slot(0x-32) -> change. Only slots where post !== pre. */
  storage: Record<string, StorageChange>
  selfDestructed: boolean
}

export interface TxDiff {
  /** addrKey -> diff. Only accounts that actually changed. */
  accounts: Record<string, AccountDiff>
}

// --------------------------------------------------------------------------
// Sandbox store: txs / receipts / logs that survive restarts.
// --------------------------------------------------------------------------
/**
 * How a contract was deployed within a tx:
 *   - 'tx':      top-level deploy via a zero-`to` (contract-creation) transaction
 *                — an EOA CREATE at depth 0 ("zero-address tx").
 *   - 'create':  internal CREATE opcode (nonce-based address) from a contract.
 *   - 'create2': internal CREATE2 opcode (salt-based address) from a contract.
 */
export type DeployMethod = 'tx' | 'create' | 'create2'

export interface StoredLog {
  address: Hex
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: Hex
  /** Global sandbox log index (monotonic across all sandbox txs). */
  logIndex: Hex
  removed: boolean
}

export interface StoredTx {
  hash: Hex
  /** Signed raw tx bytes — source of truth for nonce/v/r/s when rendering. */
  raw: Hex
  type: number
  /** Effective sender used by the EVM (impersonatee A when impersonated). */
  from: Hex
  /** Physical signer (impersonator B). Equals `from` when not impersonated. */
  signedBy: Hex
  to: Hex | null
  nonce: Hex
  value: Hex
  input: Hex
  gasLimit: Hex
  gasUsed: Hex
  /** Effective gas price (upstream eth_gasPrice at execution time). */
  gasPrice: Hex
  status: 0 | 1
  contractAddress: Hex | null
  /** Contracts deployed inside the tx (factory/CREATE2/7702), not just top-level. */
  createdContracts: Hex[]
  /**
   * Deploy mechanism per created contract (addrKey -> method), captured from the
   * EVM message stream. Keyed by lowercased 0x address, index-agnostic. Optional:
   * absent on txs stored before this field existed; the UI falls back to a
   * generic "created" label when a method is missing.
   */
  createdVia?: Record<string, DeployMethod>
  logs: StoredLog[]
  blockNumber: Hex
  blockHash: Hex
  blockTime: Hex
  /** Global sandbox sequence number (a.k.a. Index/Seq); higher = newer. */
  seq: number
  /** Execution error message, if the tx reverted/failed. */
  err?: string
  /** Decoded revert reason string, if available. */
  revertReason?: string
  /**
   * Set when the tx arrived as an EIP-191 signed message (fakereum_sendTransaction)
   * rather than signed RLP. `raw` then holds the tx the message describes with
   * the message signature's r/s/v in its signature fields (so hash and RLP are
   * real), but those fields recover a stranger — the signature covers `message`
   * (see lib/eip191.ts), and `from`/`signedBy` are the authority on the sender.
   */
  signedMessage?: SignedMessage
  diff: TxDiff
}

export interface SignedMessage {
  /** The exact text the wallet signed. */
  message: string
  /** 65-byte EIP-191 signature over `message`. */
  signature: Hex
}

// --------------------------------------------------------------------------
// Impersonation: many-to-one B -> A NAT.
// --------------------------------------------------------------------------
export interface ImpersonatorView {
  /** impersonator B (addrKey) -> impersonatee A (checksummed). */
  forward: Record<string, Hex>
  /** impersonatee A (addrKey) -> impersonator B[] (checksummed). */
  inverse: Record<string, Hex[]>
}

// --------------------------------------------------------------------------
// Discovery sentinel payload (infos.go).
// --------------------------------------------------------------------------
export interface UpstreamExplorerInfo {
  name: string
  url: string
}
export interface Infos {
  chainId: Hex
  upstreamChainId: Hex
  networkName: string
  symbol: string
  rpc?: string
  etherscanApi?: string
  etherscanApiV2?: string
  explorer?: string
  /** Primary upstream JSON-RPC URL — where a dapp checks an account's real-chain balance. */
  upstreamRpc?: string
  upstreamExplorer?: UpstreamExplorerInfo
}

// --------------------------------------------------------------------------
// ABI decoding (tx_decode.go) — consumed by the explorer UI.
// --------------------------------------------------------------------------
export interface DecodedArg {
  name: string
  type: string
  value: string
  indexed?: boolean
}
export interface DecodedCall {
  method: string
  args: DecodedArg[]
}
export interface DecodedLogEntry {
  name: string
  args: DecodedArg[]
}

// --------------------------------------------------------------------------
// eth_call / eth_estimateGas state overrides (geth-style 3rd param).
// --------------------------------------------------------------------------
export interface StateOverrideAccount {
  balance?: Hex
  nonce?: Hex
  code?: Hex
  state?: Record<string, Hex>
  stateDiff?: Record<string, Hex>
}
export type StateOverrides = Record<string, StateOverrideAccount>

// --------------------------------------------------------------------------
// Per-request context threaded into handlers (self base URL for sentinel links,
// client IP, request Origin).
// --------------------------------------------------------------------------
export interface ReqContext {
  baseURL: string
  clientIp: string
  origin: string | null
}
