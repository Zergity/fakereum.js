// End-to-end smoke test for EIP-191 signed-message transactions
// (fakereum_transactionMessage + fakereum_sendTransaction): fetch the text to
// sign, personal_sign it with a throwaway key, send, then verify the hash,
// receipt, tx page, the "already known" replay refusal, and undo. The signer
// must be able to pay gas, so it uses the genesis-funded anvil key like
// smoke-tx.mjs. Run against a local `wrangler dev` on :8787.

import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, serializeTransaction } from 'viem'

const BASE = 'http://127.0.0.1:8787'
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RECIP = '0x000000000000000000000000000000000000dEaD'

async function rpcRaw(method, params = []) {
  const r = await fetch(BASE + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return r.json()
}

async function rpc(method, params = []) {
  const j = await rpcRaw(method, params)
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('  ok:', msg)
}

const account = privateKeyToAccount(PK)
const request = { from: account.address, to: RECIP, value: '0x38d7ea4c68000', data: '0x12345678' + 'ab'.repeat(8) }

console.log('0. balances are upstream × multiplier until the account transacts')
const infosHex = (await rpc('eth_call', [{ to: '0x000000000000000000000000000000000000fa4e' }, 'latest'])).slice(2)
const infos = JSON.parse(Buffer.from(infosHex.slice(128, 128 + 2 * parseInt(infosHex.slice(64, 128), 16)), 'hex').toString())
const upstreamBal = BigInt((await (await fetch(infos.upstreamRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [RECIP, 'latest'] }) })).json()).result)
const sandboxBal = BigInt(await rpc('eth_getBalance', [RECIP, 'latest']))
const kinds = await rpc('fakereum_accountKind', [RECIP])
if (!kinds.pinned && upstreamBal > 0n) assert(sandboxBal === upstreamBal * 1000n, `dEaD shows ${sandboxBal} = 1000 × ${upstreamBal}`)
else console.log('  skip: dEaD is pinned or empty upstream')
const sources = await rpc('fakereum_importSources', [RECIP])
assert(Array.isArray(sources.sources) && sources.sources.length >= 3 && sources.sources.every((s) => s.balance || s.error), `import sources answer: ${sources.sources.map((s) => s.name + '=' + (s.balance ?? s.error)).join(', ')}`)

console.log('1. fakereum_transactionMessage (nonce read from `from`)')
const nonceBefore = BigInt(await rpc('eth_getTransactionCount', [account.address, 'latest']))
const balBefore = BigInt(await rpc('eth_getBalance', [account.address, 'latest']))
const { message, nonce } = await rpc('fakereum_transactionMessage', [request])
const lines = message.split('\n')
assert(lines[0] === `Fakereum Tx #${nonceBefore} on ${lines[0].split(' on ')[1]}` && lines[0].includes(' on '), 'header line carries the sandbox nonce')
assert(nonce === '0x' + nonceBefore.toString(16), 'returned nonce matches')
assert(lines[1] === `To: ${RECIP}`, 'To line is checksummed')
assert(lines[2] === 'Value: 0.001', 'Value line')
assert(lines[3].startsWith('Data: 0x12345678 and 8 bytes with hash 0x') && lines.length === 4, 'Data line, nothing after it')

console.log('2. personal_sign + fakereum_sendTransaction (gas / fee left for the sandbox to fill)')
const signature = await account.signMessage({ message })
const { from: _from, ...fields } = { ...request, nonce }
const hash = await rpc('fakereum_sendTransaction', [{ ...fields, signature }])
const tx = await rpc('eth_getTransactionByHash', [hash])
const raw = serializeTransaction(
  { chainId: Number(tx.chainId), type: 'eip1559', nonce: Number(tx.nonce), to: tx.to, value: BigInt(tx.value), gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), data: tx.input },
  { r: tx.r, s: tx.s, yParity: Number(BigInt(tx.v)) >= 27 ? Number(BigInt(tx.v)) - 27 : Number(BigInt(tx.v)) },
)
assert(hash === keccak256(raw), 'tx hash is the hash of the constructed tx (message signature as v/r/s)')
assert(tx.r === '0x' + signature.slice(2, 66) && tx.s === '0x' + signature.slice(66, 130), 'tx v/r/s carry the message signature')

console.log('3. tx + receipt')
assert(tx.from.toLowerCase() === account.address.toLowerCase(), 'from is the message signer')
assert(tx.nonce === nonce && BigInt(tx.gas) > 21000n && BigInt(tx.maxFeePerGas) > 0n, 'tx carries the signed nonce and filled-in gas / fee')
assert(tx.signedMessage?.message === message, 'signed message attached')
const rc = await rpc('eth_getTransactionReceipt', [hash])
assert(rc.status === '0x1' && BigInt(rc.effectiveGasPrice) > 0n, 'receipt: success at a real gas price')
const nonceAfter = BigInt(await rpc('eth_getTransactionCount', [account.address, 'latest']))
const balAfter = BigInt(await rpc('eth_getBalance', [account.address, 'latest']))
assert(nonceAfter === nonceBefore + 1n, 'nonce advanced')
const spent = balBefore - balAfter
const value = BigInt(request.value)
assert(spent > value && spent <= value + BigInt(rc.gasUsed) * BigInt(tx.maxFeePerGas), 'sender paid value + gas within the cap')

console.log('3b. contract creation via signed message')
const init = '0x602a60005260206000f3' // returns the 32-byte word 42 as runtime code
const cm = await rpc('fakereum_transactionMessage', [{ from: account.address, data: init }])
assert(cm.message.split('\n')[1] === 'To: new contract', 'To line reads "new contract"')
const chash = await rpc('fakereum_sendTransaction', [{ data: init, nonce: cm.nonce, signature: await account.signMessage({ message: cm.message }) }])
const crc = await rpc('eth_getTransactionReceipt', [chash])
assert(crc.status === '0x1' && /^0x[0-9a-fA-F]{40}$/.test(crc.contractAddress || ''), `deployed at ${crc.contractAddress}`)
const code = await rpc('eth_getCode', [crc.contractAddress, 'latest'])
assert(code === '0x' + '00'.repeat(31) + '2a', 'runtime code is the 32-byte word 42')

console.log('4. tx page')
const page = await fetch(`${BASE}/tx/${hash}`).then((r) => r.text())
assert(page.includes('Signed message (EIP-191)'), 'page shows the signed message block')

console.log('5. replay refusal')
const again = await rpcRaw('fakereum_sendTransaction', [{ ...fields, signature }])
assert(/already known|nonce/i.test(again.error?.message ?? ''), 'resending the same signed message is refused: ' + again.error?.message)

console.log('6. validation')
const one = await rpc('fakereum_transactionMessage', [{ ...fields, value: '0x1' }])
assert(one.message.split('\n')[2] === 'Value: 0.000000000000000001', '1 wei prints exactly with 18 decimals')
const { nonce: _n, ...noNonce } = fields
const missing = await rpcRaw('fakereum_sendTransaction', [{ ...noNonce, signature }])
assert(missing.error?.code === -32602 && /nonce/.test(missing.error.message), 'sendTransaction insists on the nonce')

console.log('7. account kind')
const k1 = await rpc('fakereum_accountKind', [account.address])
assert(['sandbox', 'upstream'].includes(k1.kind), `kind after a tx: ${k1.kind} (pinned=${k1.pinned}, replayGuard=${k1.replayGuard})`)
assert(k1.pinned === k1.replayGuard, 'a tx pins the kind exactly when the replay guard is on')

console.log('8. undo')
assert((await rpc('fakereum_undoLastTx')) === chash, 'undo removed the deploy')
assert((await rpc('fakereum_undoLastTx')) === hash, 'undo removed the message tx')

console.log('\nALL OK')
