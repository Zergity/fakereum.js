// Sandbox tx detail page (GET /tx/<hash>) — port of tx_explorer.go's
// txExplorerTmpl + renderSandboxTx + renderTxDiff. Renders an Etherscan-style
// view of a sandbox transaction: status/revert, from/to/contract links, value,
// nonce, gas, block info, decoded (or raw) input, logs, the full per-account
// state diff, and an "Undo back to this tx" form posting to /undo/<hash>.
//
// Pure: takes an already-assembled StoredTx (plus decoded call/logs the core
// produced) and returns an HTML string. Escaping mirrors Go's html/template
// auto-escaping and is REQUIRED here for correctness/safety — esc() wraps every
// interpolated value.

import type { Config, DecodedCall, DecodedLogEntry, DeployMethod, StoredTx, StoredLog, AccountDiff } from '../types'
import { deployPill, esc, formatAbsUTC, humanizeAgo, renderShell } from './html'
import { addrKey, checksumAddress, toBigInt, strip0x } from '../lib/hex'
import { resolveDeployMethod } from '../lib/deploy'
import type { UpstreamExplorer } from '../lib/chains'

export interface RenderTxPageOpts {
  tx: StoredTx
  cfg: Config
  /** Decoded call data for the tx input, or null if no ABI / no input. */
  decoded: DecodedCall | null
  /** Per-log decoded event, index-aligned with tx.logs; entry null if undecodable. */
  decodedLogs: (DecodedLogEntry | null)[]
  explorer: UpstreamExplorer
  baseURL: string
}

interface PrePost {
  pre: string
  post: string
}

interface SlotRow {
  slot: string
  pre: string
  post: string
}

interface TxDiffRow {
  address: string
  addressURL: string
  created: boolean
  /** Deploy mechanism when `created`; undefined for old txs / non-deploys. */
  deployMethod?: DeployMethod
  selfDestructed: boolean
  balance: PrePost | null
  nonce: PrePost | null
  code: PrePost | null
  storage: SlotRow[]
}

// --- helpers ----------------------------------------------------------------

/** Minimal hex of a uint, mirroring Go's printf "%x" (no leading zeros). */
function hexNoPrefix(n: bigint): string {
  return n.toString(16)
}

/** Decimal string from a QUANTITY hex (or empty/undefined -> "0"). */
function dec(hex: string | null | undefined): string {
  return toBigInt(hex ?? '').toString()
}

// renderTxDiff converts the per-tx state diff into rendering rows. Addresses
// are sorted lexicographically by checksummed hex so the same tx renders in the
// same order across reloads. Storage slots inside each row are sorted likewise.
function renderTxDiff(tx: StoredTx): TxDiffRow[] {
  const accounts = tx.diff?.accounts
  if (!accounts) return []
  const keys = Object.keys(accounts)
  if (keys.length === 0) return []

  // Pair each map key with its checksummed address (matches Go's a.Hex()).
  const entries = keys.map((k) => {
    const ad = accounts[k] as AccountDiff
    return { addr: checksumAddress(k), ad }
  })
  entries.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))

  const rows: TxDiffRow[] = []
  for (const { addr, ad } of entries) {
    const created = !ad.preExists && ad.postExists
    // A code deploy: empty code -> non-empty code (matches deriveCreatedContracts).
    // Gate the deploy badge on this, not on `created`, so CREATE2 into a
    // pre-funded address is still labelled and a plain new EOA is not.
    const isDeploy = ad.codeChanged && !!ad.postCode && ad.postCode !== '0x' && (!ad.preCode || ad.preCode === '0x')
    const row: TxDiffRow = {
      address: addr,
      addressURL: '/address/' + addr,
      created,
      deployMethod: isDeploy ? resolveDeployMethod(tx, addrKey(addr)) : undefined,
      selfDestructed: ad.selfDestructed,
      balance: null,
      nonce: null,
      code: null,
      storage: [],
    }
    if (ad.balanceChanged) {
      row.balance = { pre: dec(ad.preBalance), post: dec(ad.postBalance) }
    }
    if (ad.nonceChanged) {
      row.nonce = { pre: dec(ad.preNonce), post: dec(ad.postNonce) }
    }
    if (ad.codeChanged) {
      // Go hexutil.Encode of pre/post code bytes ("0x" + hex).
      row.code = { pre: ad.preCode ?? '0x', post: ad.postCode ?? '0x' }
    }
    const storage = ad.storage
    if (storage && Object.keys(storage).length > 0) {
      const slots = Object.keys(storage)
      slots.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const slot of slots) {
        const sc = storage[slot]!
        row.storage.push({ slot, pre: sc.pre, post: sc.post })
      }
    }
    rows.push(row)
  }
  return rows
}

// --- arg / decoded rendering ------------------------------------------------

function renderDecodedCall(decoded: DecodedCall): string {
  const args = decoded.args
    .map(
      (a) =>
        `      <div class="arg">  <span class="argname">${a.name ? esc(a.name) : '_'}</span> ` +
        `<span class="argtype">${esc(a.type)}</span> = <span class="argval">${esc(a.value)}</span></div>`,
    )
    .join('\n')
  return `    <div class="decoded">
      <div class="method">${esc(decoded.method)}(</div>
${args}
      <div class="method">)</div>
    </div>`
}

function renderDecodedEvent(decoded: DecodedLogEntry): string {
  const args = decoded.args
    .map(
      (a) =>
        `                <div class="arg">  <span class="argname">${a.name ? esc(a.name) : '_'}</span>` +
        `${a.indexed ? ' <span class="indexed">indexed</span>' : ''} ` +
        `<span class="argtype">${esc(a.type)}</span> = <span class="argval">${esc(a.value)}</span></div>`,
    )
    .join('\n')
  return `            <div class="decoded">
              <div class="method">${esc(decoded.name)}(</div>
${args}
              <div class="method">)</div>
            </div>`
}

function renderLog(l: StoredLog, decoded: DecodedLogEntry | null): string {
  const addr = checksumAddress(l.address)
  const addrURL = '/address/' + addr
  const index = toBigInt(l.logIndex).toString()
  const topics = l.topics.map((t) => `<li>${esc(t)}</li>`).join('')
  const eventBlock = decoded
    ? `      <dl class="kv"><dt>Event:</dt><dd>
${renderDecodedEvent(decoded)}
      </dd></dl>
`
    : ''
  return `    <div class="logitem">
      <dl class="kv"><dt>Log index:</dt><dd>${esc(index)}</dd></dl>
      <dl class="kv"><dt>Address:</dt><dd class="mono"><a href="${esc(addrURL)}" rel="noopener noreferrer">${esc(addr)}</a></dd></dl>
${eventBlock}      <dl class="kv"><dt>Topics:</dt><dd><ol class="topics" start="0">${topics}</ol></dd></dl>
      <dl class="kv"><dt>Data:</dt><dd class="mono">${esc(l.data)}</dd></dl>
    </div>`
}

function renderDiffRow(row: TxDiffRow): string {
  const pills =
    (row.created ? '<span class="badge sandbox">created</span> ' : '') +
    (row.deployMethod ? deployPill(row.deployMethod) : '') +
    (row.selfDestructed ? ' <span class="badge err">self-destructed</span>' : '')
  const kv = (k: string, v: string) => `      <dl class="kv"><dt>${k}:</dt><dd>${v}</dd></dl>\n`

  let balance = ''
  if (row.balance) {
    balance = kv(
      'Balance',
      `<span class="diffpre">${esc(row.balance.pre)}</span> &rarr; <span class="diffpost">${esc(row.balance.post)}</span> <span class="muted">wei</span>`,
    )
  }

  let nonce = ''
  if (row.nonce) {
    nonce = kv(
      'Nonce',
      `<span class="diffpre">${esc(row.nonce.pre)}</span> &rarr; <span class="diffpost">${esc(row.nonce.post)}</span>`,
    )
  }

  let code = ''
  if (row.code) {
    code = kv(
      'Code',
      `<details><summary>${row.code.pre.length} &rarr; ${row.code.post.length} chars</summary>
              <div class="muted">pre</div><pre>${esc(row.code.pre)}</pre>
              <div class="muted">post</div><pre>${esc(row.code.post)}</pre>
            </details>`,
    )
  }

  let storage = ''
  if (row.storage.length > 0) {
    const slotRows = row.storage
      .map(
        (s) =>
          `<tr><td class="wrap mono">${esc(s.slot)}</td><td class="wrap mono diffpre">${esc(
            s.pre,
          )}</td><td class="wrap mono diffpost">${esc(s.post)}</td></tr>`,
      )
      .join('\n')
    storage = kv(
      `Storage (${row.storage.length})`,
      `<div class="tablewrap"><table class="list">
              <thead><tr><th>Slot</th><th>Before</th><th>After</th></tr></thead>
              <tbody>
${slotRows}
              </tbody>
            </table></div>`,
    )
  }

  return `    <div class="logitem">
${kv('Address', `<a class="mono" href="${esc(row.addressURL)}" rel="noopener noreferrer">${esc(row.address)}</a> ${pills}`)}${balance}${nonce}${code}${storage}    </div>`
}

// --- page -------------------------------------------------------------------

export function renderTxPage(opts: RenderTxPageOpts): string {
  const { tx, cfg, decoded, decodedLogs, explorer, baseURL } = opts

  const hash = tx.hash
  const statusOK = tx.status === 1
  const revertReason = tx.revertReason ?? ''
  const err = tx.err ?? ''

  const row = (k: string, v: string) => `    <dl class="kv"><dt>${k}:</dt><dd>${v}</dd></dl>\n`
  const addrLink = (a: string) => `<a class="mono" href="${esc('/address/' + a)}" rel="noopener noreferrer">${esc(a)}</a>`

  const from = checksumAddress(tx.from)
  const toBlock = tx.to ? row('To', addrLink(checksumAddress(tx.to))) : ''

  const contractBlock = tx.contractAddress
    ? row(
        'Contract created',
        `${addrLink(checksumAddress(tx.contractAddress))} ${deployPill(resolveDeployMethod(tx, addrKey(tx.contractAddress)))}`,
      )
    : ''

  // CreatedContracts is the full deploy set (top-level + internal). Skip the one
  // matching the top-level contractAddress so it isn't rendered twice.
  const topLevel = tx.contractAddress ? strip0x(tx.contractAddress).toLowerCase() : null
  const internal = tx.createdContracts
    .filter((a) => topLevel === null || strip0x(a).toLowerCase() !== topLevel)
    .map((a) => ({ addr: checksumAddress(a), method: resolveDeployMethod(tx, addrKey(a)) }))
  const createdBlock =
    internal.length > 0
      ? row(
          'Internal deploys',
          internal.map(({ addr, method }) => `<div>${addrLink(addr)} ${deployPill(method)}</div>`).join(''),
        )
      : ''

  const valueDec = toBigInt(tx.value).toString()
  const valueBlock = row('Value', `${esc(valueDec)} <span class="muted">wei</span>`)

  const viaBlock = tx.signedMessage
    ? row('Submitted as', 'EIP-191 signed message <span class="muted">(personal_sign)</span>')
    : ''
  const gasUsed = toBigInt(tx.gasUsed)
  const gasLimit = toBigInt(tx.gasLimit)
  const gasLine =
    gasLimit > 0n
      ? `${esc(gasUsed.toString())} <span class="muted">/ ${esc(gasLimit.toString())}</span>`
      : esc(gasUsed.toString())

  // A message tx also shows the text the wallet signed and its signature, so
  // anyone can re-verify the signer with personal_ecRecover.
  const rawSection =
    (tx.signedMessage
      ? `<details open>
      <summary>Signed message (EIP-191)</summary>
      <pre>${esc(tx.signedMessage.message)}</pre>
      <div class="muted">signature</div>
      <pre>${esc(tx.signedMessage.signature)}</pre>
    </details>
`
      : '') +
    `<details>
      <summary>Raw tx</summary>${tx.signedMessage ? '\n      <div class="muted">v/r/s are the message signature; the sender is the message signer, not what they recover to</div>' : ''}
      <pre>${esc(tx.raw)}</pre>
    </details>`

  const blockNumber = toBigInt(tx.blockNumber)
  let blockBlock = ''
  if (blockNumber > 0n) {
    const blockURL = explorer.base ? explorer.base + '/block/' + blockNumber.toString() : ''
    const numCell = blockURL
      ? `<a href="${esc(blockURL)}" rel="noopener noreferrer">${esc(blockNumber.toString())}</a>`
      : esc(blockNumber.toString())
    const onExplorer = explorer.name ? ` &middot; on ${esc(explorer.name)}` : ''
    blockBlock = row(
      'Block',
      `${numCell} <span class="muted">(0x${esc(hexNoPrefix(blockNumber))}${onExplorer})</span>`,
    )
  }

  const blockTime = Number(toBigInt(tx.blockTime))
  const timeBlock =
    blockTime > 0
      ? row('Timestamp', `${esc(humanizeAgo(blockTime, Math.floor(Date.now() / 1000)))} <span class="muted">(${esc(formatAbsUTC(blockTime))})</span>`)
      : ''

  const blockHashBlock = tx.blockHash && tx.blockHash !== '0x' ? row('Block hash', `<span class="mono">${esc(tx.blockHash)}</span>`) : ''

  const revertBlock = revertReason ? row('Revert reason', `<span class="err">${esc(revertReason)}</span>`) : ''

  const statusBadge = statusOK
    ? '<span class="badge ok">&#10003; Success</span>'
    : `<span class="badge err">&#10007; Reverted</span>${err ? ` <span class="err">(${esc(err)})</span>` : ''}`

  // Input data section: decoded call when available, else a hint when there is
  // a target contract but no ABI.
  let inputSection = ''
  if (decoded) {
    inputSection = renderDecodedCall(decoded)
  } else if (tx.to) {
    const explorerName = explorer.name ? esc(explorer.name) : 'the upstream explorer'
    inputSection = `<p class="muted">No matching ABI on file for the target contract. Submit it to ${explorerName} to enable decoding.</p>`
  }

  const logs = tx.logs.map((l, i) => renderLog(l, decodedLogs[i] ?? null)).join('\n')
  const logsSection = logs || `<div class="empty">No logs emitted.</div>`

  const diffRows = renderTxDiff(tx)
  const diffSection =
    diffRows.length > 0
      ? diffRows.map(renderDiffRow).join('\n')
      : `<div class="empty">No state changes recorded for this tx.</div>`

  const body = `  <div class="tabs">
    <a href="#overview" class="on">Overview</a>
    <a href="#logs">Logs (${tx.logs.length})</a>
    <a href="#state">State (${diffRows.length})</a>
  </div>

  <section class="panel-tab" id="overview">
    <div class="card"><div class="bd">
${row('Transaction hash', `<span class="mono">${esc(hash)}</span>`)}${row('Status', statusBadge)}${revertBlock}${blockBlock}${timeBlock}${blockHashBlock}${row('From', addrLink(from))}${toBlock}${contractBlock}${createdBlock}${valueBlock}${viaBlock}${row('Nonce', esc(toBigInt(tx.nonce).toString()))}${row('Gas used', gasLine)}
    </div></div>
    <div class="card">
      <div class="hd">Input data</div>
      <div class="pad">
        ${inputSection}
        <details ${decoded ? '' : 'open'}>
          <summary>Raw input</summary>
          <pre>${esc(tx.input)}</pre>
        </details>
        ${rawSection}
      </div>
    </div>
    <form class="row" method="post" action="/undo/${esc(hash)}" onsubmit="return confirm('Undo this tx and every tx submitted after it?');">
      <button type="submit" class="btn btn-undo">Undo back to this tx</button>
      <span class="muted">rewinds the overlay and removes this tx and every later sandbox tx</span>
    </form>
  </section>

  <section class="panel-tab" id="logs">
    <div class="card"><div class="hd">Transaction receipt event logs</div>
${logsSection}
    </div>
  </section>

  <section class="panel-tab" id="state">
    <div class="card"><div class="hd">State changes <span class="muted">(${diffRows.length} ${diffRows.length === 1 ? 'account' : 'accounts'})</span></div>
${diffSection}
    </div>
  </section>`

  return renderShell({
    title: `Sandbox tx ${hash.slice(0, 10)}…`,
    heading: 'Transaction Details',
    sub: hash,
    symbol: cfg.symbol,
    networkName: cfg.networkName,
    chainId: cfg.chainId.toString(),
    baseURL,
    body,
  })
}
