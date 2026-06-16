// End-to-end smoke test for eth_sendRawTransaction (the defining feature):
// sign a real EIP-1559 tx with the genesis-funded anvil key, send it, then
// verify the receipt, the sticky overlay write, and undo. Run against a local
// `wrangler dev` on :8787.

import { privateKeyToAccount } from 'viem/accounts'

const URL = 'http://127.0.0.1:8787/rpc'
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const RECIP = '0x000000000000000000000000000000000000dEaD'

async function rpc(method, params = []) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('  ok:', msg)
}

const account = privateKeyToAccount(PK)

console.log('1) genesis-funded sender balance')
const startBal = BigInt(await rpc('eth_getBalance', [SENDER, 'latest']))
assert(startBal === 10n ** 20n, `sender has 100 FETH (got ${startBal})`)

console.log('2) recipient starts at its upstream value (fall-through)')
const recipBefore = BigInt(await rpc('eth_getBalance', [RECIP, 'latest']))
console.log(`  recipient upstream balance = ${recipBefore} (read-through to upstream)`)

console.log('3) sign + send a 1 FETH transfer')
const signed = await account.signTransaction({
  chainId: 4201,
  nonce: 0,
  to: RECIP,
  value: 10n ** 18n,
  gas: 21000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  type: 'eip1559',
})
const hash = await rpc('eth_sendRawTransaction', [signed])
assert(/^0x[0-9a-f]{64}$/.test(hash), `got tx hash ${hash}`)

console.log('4) receipt is served from the sandbox')
const receipt = await rpc('eth_getTransactionReceipt', [hash])
assert(receipt && receipt.status === '0x1', `receipt status success (got ${receipt?.status})`)
assert(BigInt(receipt.gasUsed) === 21000n, `gasUsed 21000 (got ${BigInt(receipt.gasUsed)})`)

console.log('5) overlay write is sticky: recipient credited +1 FETH over its upstream value')
const recipAfter = BigInt(await rpc('eth_getBalance', [RECIP, 'latest']))
assert(recipAfter === recipBefore + 10n ** 18n, `recipient +1 FETH after (got ${recipAfter - recipBefore})`)

console.log('6) sender debited by value + gas')
const senderAfter = BigInt(await rpc('eth_getBalance', [SENDER, 'latest']))
assert(senderAfter < startBal - 10n ** 18n, `sender debited value+gas (got ${senderAfter})`)
assert(BigInt(await rpc('eth_getTransactionCount', [SENDER, 'latest'])) === 1n, 'sender nonce bumped to 1')

console.log('7) getLogs merge returns an array (narrow range to respect upstream cap)')
const logs = await rpc('eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest', address: RECIP }])
assert(Array.isArray(logs), 'eth_getLogs returns a merged array')

console.log('8) undo last tx rewinds the overlay')
const popped = await rpc('fakereum_undoLastTx', [])
assert(popped === hash, `undo returned the popped hash (got ${popped})`)
const recipUndone = BigInt(await rpc('eth_getBalance', [RECIP, 'latest']))
assert(recipUndone === recipBefore, `recipient back to upstream value after undo (got ${recipUndone})`)
const receiptGone = await rpc('eth_getTransactionReceipt', [hash])
assert(receiptGone === null, 'receipt gone after undo (falls through to upstream null)')

console.log('\nALL SANDBOX TX TESTS PASSED ✅')
