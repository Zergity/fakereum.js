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
import { deployPill, esc, explorerCSS } from './html'
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
    ? `        <dt>Event</dt>
          <dd>
${renderDecodedEvent(decoded)}
          </dd>
`
    : ''
  return `    <div class="log">
      <dl>
        <dt>Index</dt>   <dd>${esc(index)}</dd>
        <dt>Address</dt> <dd><a href="${esc(addrURL)}" rel="noopener noreferrer">${esc(addr)}</a></dd>
${eventBlock}        <dt>Topics</dt>
        <dd>
          <ol class="topics" start="0">
            ${topics}
          </ol>
        </dd>
        <dt>Data</dt>    <dd>${esc(l.data)}</dd>
      </dl>
    </div>`
}

function renderDiffRow(row: TxDiffRow): string {
  const pills =
    (row.created ? '<span class="pill sandbox">created</span>' : '') +
    (row.deployMethod ? deployPill(row.deployMethod) : '') +
    (row.selfDestructed ? '<span class="pill err">self-destructed</span>' : '')

  let balance = ''
  if (row.balance) {
    balance = `        <dt>Balance</dt>
          <dd><span class="diffpre">${esc(row.balance.pre)}</span> &rarr; <span class="diffpost">${esc(
            row.balance.post,
          )}</span> <span class="muted">wei</span></dd>
`
  }

  let nonce = ''
  if (row.nonce) {
    nonce = `        <dt>Nonce</dt>
          <dd><span class="diffpre">${esc(row.nonce.pre)}</span> &rarr; <span class="diffpost">${esc(
            row.nonce.post,
          )}</span></dd>
`
  }

  let code = ''
  if (row.code) {
    code = `        <dt>Code</dt>
          <dd>
            <details><summary>${row.code.pre.length} &rarr; ${row.code.post.length} chars</summary>
              <div class="muted">pre</div><pre>${esc(row.code.pre)}</pre>
              <div class="muted">post</div><pre>${esc(row.code.post)}</pre>
            </details>
          </dd>
`
  }

  let storage = ''
  if (row.storage.length > 0) {
    const slotRows = row.storage
      .map(
        (s) =>
          `                  <tr><td>${esc(s.slot)}</td><td class="diffpre">${esc(
            s.pre,
          )}</td><td class="diffpost">${esc(s.post)}</td></tr>`,
      )
      .join('\n')
    storage = `        <dt>Storage (${row.storage.length})</dt>
          <dd>
            <table class="slots">
              <thead><tr><th>slot</th><th>pre</th><th>post</th></tr></thead>
              <tbody>
${slotRows}
              </tbody>
            </table>
          </dd>
`
  }

  return `    <div class="log">
      <dl>
        <dt>Address</dt>
        <dd>
          <a href="${esc(row.addressURL)}" rel="noopener noreferrer">${esc(row.address)}</a>
          ${pills}
        </dd>
${balance}${nonce}${code}${storage}      </dl>
    </div>`
}

// --- page -------------------------------------------------------------------

export function renderTxPage(opts: RenderTxPageOpts): string {
  const { tx, cfg, decoded, decodedLogs, explorer } = opts

  const hash = tx.hash
  const statusOK = tx.status === 1
  const status = statusOK ? 'Success' : 'Reverted'
  const err = tx.err ?? ''
  const revertReason = tx.revertReason ?? ''

  const from = checksumAddress(tx.from)
  const fromURL = '/address/' + from

  let toBlock = ''
  if (tx.to) {
    const to = checksumAddress(tx.to)
    const toURL = '/address/' + to
    toBlock = `    <dt>To</dt>      <dd><a href="${esc(toURL)}" rel="noopener noreferrer">${esc(to)}</a></dd>\n`
  }

  let contractBlock = ''
  if (tx.contractAddress) {
    const c = checksumAddress(tx.contractAddress)
    const cURL = '/address/' + c
    const method = resolveDeployMethod(tx, addrKey(tx.contractAddress))
    contractBlock = `    <dt>Contract created</dt><dd><a href="${esc(cURL)}" rel="noopener noreferrer">${esc(
      c,
    )}</a>${deployPill(method)}</dd>\n`
  }

  // CreatedContracts is the full deploy set (top-level + internal). Skip the one
  // matching the top-level contractAddress so it isn't rendered twice.
  const topLevel = tx.contractAddress ? strip0x(tx.contractAddress).toLowerCase() : null
  const internal = tx.createdContracts
    .filter((a) => topLevel === null || strip0x(a).toLowerCase() !== topLevel)
    .map((a) => ({ addr: checksumAddress(a), method: resolveDeployMethod(tx, addrKey(a)) }))
  let createdBlock = ''
  if (internal.length > 0) {
    const links = internal
      .map(
        ({ addr, method }, i) =>
          `${i ? '<br>' : ''}<a href="${esc('/address/' + addr)}" rel="noopener noreferrer">${esc(addr)}</a>${deployPill(method)}`,
      )
      .join('')
    createdBlock = `    <dt>Internal deploys</dt><dd>${links}</dd>\n`
  }

  const valueDec = toBigInt(tx.value).toString()
  let valueBlock = ''
  if (valueDec !== '0') {
    valueBlock = `    <dt>Value (wei)</dt><dd>${esc(valueDec)}</dd>\n`
  }

  const nonceDec = toBigInt(tx.nonce).toString()
  const viaBlock = tx.signedMessage
    ? `    <dt>Submitted as</dt><dd>EIP-191 signed message <span class="muted">(personal_sign)</span></dd>\n`
    : ''
  const gasUsed = toBigInt(tx.gasUsed)
  const gasLimit = toBigInt(tx.gasLimit)
  const gasLine = gasLimit > 0n ? `${esc(gasUsed.toString())} / ${esc(gasLimit.toString())}` : esc(gasUsed.toString())

  // A message tx also shows the text the wallet signed and its signature, so
  // anyone can re-verify the signer with personal_ecRecover.
  const rawSection =
    (tx.signedMessage
      ? `  <details open>
    <summary>Signed message (EIP-191)</summary>
    <pre>${esc(tx.signedMessage.message)}</pre>
    <div class="muted" style="margin-top:.5rem">signature</div>
    <pre>${esc(tx.signedMessage.signature)}</pre>
  </details>
`
      : '') +
    `  <details>
    <summary>Raw tx${tx.signedMessage ? ' <span class="muted">(v/r/s are the message signature; the sender is the message signer, not what they recover to)</span>' : ''}</summary>
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
    blockBlock = `    <dt>Block</dt><dd>${numCell} <span style="color:#7d8590">(0x${esc(
      hexNoPrefix(blockNumber),
    )}${onExplorer})</span></dd>\n`
  }

  let blockHashBlock = ''
  if (tx.blockHash && tx.blockHash !== '0x') {
    blockHashBlock = `    <dt>Block hash</dt><dd>${esc(tx.blockHash)}</dd>\n`
  }

  const blockTime = toBigInt(tx.blockTime)
  let blockTimeBlock = ''
  if (blockTime > 0n) {
    blockTimeBlock = `    <dt>Block time</dt><dd>${esc(blockTime.toString())}</dd>\n`
  }

  let revertBlock = ''
  if (revertReason) {
    revertBlock = `    <dt>Revert reason</dt><dd class="err">${esc(revertReason)}</dd>\n`
  }

  const errSpan = err ? ` <span class="err">(${esc(err)})</span>` : ''

  // Input data section: decoded call when available, else a hint when there is
  // a target contract but no ABI.
  let inputSection: string
  if (decoded) {
    inputSection = renderDecodedCall(decoded)
  } else if (tx.to) {
    const explorerName = explorer.name ? esc(explorer.name) : 'the upstream explorer'
    inputSection = `    <p class="muted">no matching ABI on file for the target contract — submit it to ${explorerName} to enable decoding.</p>`
  } else {
    inputSection = ''
  }

  const logs = tx.logs
    .map((l, i) => renderLog(l, decodedLogs[i] ?? null))
    .join('\n')
  const logsSection = logs || `    <p class="muted">no logs emitted</p>`

  const diffRows = renderTxDiff(tx)
  const diffSection =
    diffRows.length > 0
      ? diffRows.map(renderDiffRow).join('\n')
      : `    <p class="muted">no state changes recorded for this tx.</p>`
  const accountWord = diffRows.length === 1 ? 'account' : 'accounts'

  const networkName = esc(cfg.networkName)
  const sandboxChainID = esc(cfg.chainId.toString())
  const hashShort = esc(hash.slice(0, 10))

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox tx ${hashShort}…</title>
<style>${explorerCSS}</style>
</head>
<body>
  <div class="nav"><a href="/">&larr; fakereum</a></div>
  <div class="tag">sandbox transaction · ${networkName} (chain ${sandboxChainID})</div>
  <h1>${esc(hash)}</h1>

  <form method="post" action="/undo/${esc(hash)}" style="margin-bottom:1rem;" onsubmit="return confirm('Undo this tx and every tx submitted after it?');">
    <button type="submit" class="undo">Undo back to this tx</button>
    <span class="muted" style="font-size:.85rem; margin-left:.5rem;">rewinds the overlay and removes this + every later sandbox tx</span>
  </form>

  <dl>
    <dt>Status</dt>            <dd class="${statusOK ? 'ok' : 'err'}">${esc(status)}${errSpan}</dd>
${revertBlock}    <dt>From</dt>              <dd><a href="${esc(fromURL)}" rel="noopener noreferrer">${esc(from)}</a></dd>
${toBlock}${contractBlock}${createdBlock}${valueBlock}${viaBlock}    <dt>Nonce</dt>             <dd>${esc(nonceDec)}</dd>
    <dt>Gas used / limit</dt>  <dd>${gasLine}</dd>
${blockBlock}${blockHashBlock}${blockTimeBlock}  </dl>

  <div class="tag">input data</div>
${inputSection}
  <details ${decoded ? '' : 'open'}>
    <summary>Raw input</summary>
    <pre>${esc(tx.input)}</pre>
  </details>

  <div class="tag">logs (${tx.logs.length})</div>
${logsSection}

  <div class="tag">state changes (${diffRows.length} ${accountWord})</div>
${diffSection}

${rawSection}
</body>
</html>`
}
