import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { hashMessage, keccak256 as viemKeccak, serializeTransaction } from 'viem'
import {
  formatMessageData,
  formatMessageValue,
  messageDigest,
  recoverMessageSigner,
  transactionMessage,
  VALUE_GRANULARITY_WEI,
  type MessageTxFields,
} from '../src/lib/eip191'
import { parseParams, rpcSendMessageTx, rpcTransactionMessage, type MessageTxDeps } from '../src/message_tx'
import { renderReceipt, renderTx } from '../src/render'
import { bytesToHex, hexToBytes, toAddress, toQuantity, type Hex } from '../src/lib/hex'
import type { Config, StoredTx } from '../src/types'
import type { RpcRequest } from '../src/rpc'

// A well-known throwaway key (hardhat account #1); never funded on any real chain.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const account = privateKeyToAccount(PK)
const NETWORK = 'Fake Arbitrum One'
const TO = '0x1111111111111111111111111111111111111111' as Hex
const cfg = { networkName: NETWORK, chainId: 42161n } as unknown as Config

const ETH = 10n ** 18n
const GWEI = 10n ** 9n

/** The signed field set; override what a test cares about. */
function fields(over: Partial<MessageTxFields> = {}): MessageTxFields {
  return { nonce: 12n, to: TO, value: 0n, data: new Uint8Array(0), ...over }
}

const HEADER = `Fakereum Tx #12 on ${NETWORK}`

function req(method: string, p: Record<string, unknown>): RpcRequest {
  return { jsonrpc: '2.0', id: 7, method, params: [p] }
}

/** eth_sendTransaction-shaped params for the given signed fields. */
const json = (f: MessageTxFields): Record<string, unknown> => ({
  to: f.to,
  value: toQuantity(f.value),
  data: bytesToHex(f.data),
  nonce: toQuantity(f.nonce),
})

const deps: MessageTxDeps = {
  nonce: async () => 12n,
  estimateGas: async () => 21000n,
  gasPrice: async () => GWEI / 10n,
}

describe('formatMessageValue', () => {
  it('prints whole units and trims trailing zeros of a 10-digit fraction', () => {
    expect(formatMessageValue(0n)).toBe('0')
    expect(formatMessageValue(ETH)).toBe('1')
    expect(formatMessageValue(ETH / 1000n)).toBe('0.001')
    expect(formatMessageValue(12n * ETH + ETH / 2n)).toBe('12.5')
    expect(formatMessageValue(VALUE_GRANULARITY_WEI)).toBe('0.0000000001')
    expect(formatMessageValue(1234567890123n * VALUE_GRANULARITY_WEI)).toBe('123.4567890123')
  })

  it('rejects amounts finer than 10 decimals', () => {
    expect(() => formatMessageValue(1n)).toThrow(/multiple of 100000000 wei/)
    expect(() => formatMessageValue(VALUE_GRANULARITY_WEI + 1n)).toThrow()
  })
})

describe('transactionMessage', () => {
  it('puts the nonce in the header and omits Value / Data when zero / empty', () => {
    expect(transactionMessage(NETWORK, fields())).toBe(`${HEADER}\nTo: ${TO}`)
    expect(transactionMessage(NETWORK, fields({ nonce: 0n })).split('\n')[0]).toBe(`Fakereum Tx #0 on ${NETWORK}`)
  })

  it('renders a contract creation as "To: new contract" with the init code summarized', () => {
    const init = hexToBytes('0x6080604052' + 'cc'.repeat(40))
    const msg = transactionMessage(NETWORK, fields({ to: null, data: init }))
    expect(msg.split('\n')).toEqual([HEADER, 'To: new contract', `Data: ${formatMessageData(init)}`])
  })

  it('checksums the address and prints the value line', () => {
    const to = toAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')
    expect(transactionMessage(NETWORK, fields({ to, value: ETH / 1000n }))).toBe(
      `${HEADER}\nTo: 0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B\nValue: 0.001`,
    )
  })

  it('shows only the selector for calldata of at most 4 bytes', () => {
    expect(formatMessageData(hexToBytes('0x12345678'))).toBe('0x12345678')
    expect(formatMessageData(hexToBytes('0x1234'))).toBe('0x1234')
  })

  it('adds the trailing-byte count and keccak256 of the bytes after the selector', () => {
    const tail = new Uint8Array(123).fill(0xaa)
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...tail])
    const line = formatMessageData(data)
    expect(line).toBe(`0x12345678 and 123 bytes with hash ${viemKeccak(tail)}`)
    expect(transactionMessage(NETWORK, fields({ value: 5n * ETH, data })).split('\n')).toEqual([
      HEADER,
      `To: ${TO}`,
      'Value: 5',
      `Data: ${line}`,
    ])
  })
})

describe('signature round-trip', () => {
  const f = fields({ value: ETH / 1000n, data: hexToBytes('0xa9059cbb' + '00'.repeat(64)) })

  it('recovers the wallet that personal_sign-ed the message', async () => {
    const message = transactionMessage(NETWORK, f)
    const sig = await account.signMessage({ message })
    expect(messageDigest(message)).toBe(hashMessage(message))
    expect(await recoverMessageSigner(message, sig)).toBe(account.address.toLowerCase())
  })

  it('binds every field: value, nonce, data, to, network', async () => {
    const sig = await account.signMessage({ message: transactionMessage(NETWORK, f) })
    const variants = [
      transactionMessage(NETWORK, { ...f, value: f.value + VALUE_GRANULARITY_WEI }),
      transactionMessage(NETWORK, { ...f, nonce: 13n }),
      transactionMessage(NETWORK, { ...f, data: hexToBytes('0xa9059cbb' + '00'.repeat(63) + '01') }),
      transactionMessage(NETWORK, { ...f, to: toAddress('0x' + '22'.repeat(20)) }),
      transactionMessage('Fake Ethereum', f),
    ]
    for (const v of variants) {
      expect(await recoverMessageSigner(v, sig)).not.toBe(account.address.toLowerCase())
    }
  })

  it('rejects a signature that is not 65 bytes', async () => {
    await expect(recoverMessageSigner('x', '0x1234')).rejects.toThrow(/65-byte/)
  })

})

describe('parseParams', () => {
  it('parses eth_sendTransaction-shaped params, with optional unsigned gas terms', () => {
    const f = fields({ value: ETH / 1000n, data: hexToBytes('0x1234') })
    const r = parseParams(req('x', json(f)))
    expect(r.ok && r.value).toEqual({ ...f, nonce: 12n, gasLimit: undefined, fee: undefined })
    const r2 = parseParams(req('x', { ...json(f), gas: '0x5208', gasPrice: toQuantity(3n * GWEI) }))
    expect(r2.ok && r2.value.gasLimit).toBe(21000n)
    expect(r2.ok && r2.value.fee).toEqual({ gasPrice: 3n * GWEI })
    const r3 = parseParams(req('x', { ...json(f), maxFeePerGas: toQuantity(GWEI) }))
    expect(r3.ok && r3.value.fee).toEqual({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 0n })
  })

  it('treats a missing, null or empty `to` as a contract creation', () => {
    for (const to of [undefined, null, '']) {
      const r = parseParams(req('x', { to, data: '0x6080', nonce: '0x1' }))
      expect(r.ok && r.value.to).toBeNull()
    }
    expect(parseParams(req('x', { to: '0x12', data: '0x6080' }))).toMatchObject({ ok: false, error: /omitted for a contract creation/ })
  })

  it('accepts `input` as an alias of `data` and leaves nonce undefined when omitted', () => {
    const r = parseParams(req('x', { to: TO, input: '0xab' }))
    expect(r.ok && r.value).toMatchObject({ to: TO, value: 0n, nonce: undefined })
    expect(r.ok && Array.from(r.value.data)).toEqual([0xab])
  })

  it('rejects malformed or contradictory fields', () => {
    const f = json(fields())
    expect(parseParams(req('x', { ...f, to: '0x12' })).ok).toBe(false)
    expect(parseParams(req('x', { ...f, value: '1000' })).ok).toBe(false)
    expect(parseParams(req('x', { ...f, value: '0.001' })).ok).toBe(false)
    expect(parseParams(req('x', { ...f, data: '0x123' })).ok).toBe(false)
    expect(parseParams(req('x', { ...f, gasPrice: '0x1', maxFeePerGas: '0x1' }))).toMatchObject({
      ok: false,
      error: /not both/,
    })
    expect(parseParams(req('x', { ...f, maxFeePerGas: '0x1', maxPriorityFeePerGas: toQuantity(GWEI) }))).toMatchObject({
      ok: false,
      error: /must not exceed/,
    })
    expect(parseParams(req('x', { to: TO, maxPriorityFeePerGas: '0x1' }))).toMatchObject({
      ok: false,
      error: /requires maxFeePerGas/,
    })
    expect(parseParams({ method: 'x', params: [] }).ok).toBe(false)
  })
})

describe('rpcTransactionMessage', () => {
  it('returns the text and the nonce it used when nonce is given', async () => {
    const f = fields({ value: ETH / 1000n, nonce: 5n })
    const resp = await rpcTransactionMessage(req('fakereum_transactionMessage', json(f)), cfg, deps)
    expect(resp.result).toEqual({ message: transactionMessage(NETWORK, f), nonce: '0x5' })
  })

  it('reads the nonce from the sandbox when `from` is given', async () => {
    const seen: Hex[] = []
    const from = account.address.toLowerCase() as Hex
    const resp = await rpcTransactionMessage(
      req('fakereum_transactionMessage', { from, to: TO, data: '0x1234' }),
      cfg,
      { ...deps, nonce: async (a) => (seen.push(a), 12n) },
    )
    expect(seen).toEqual([from])
    expect(resp.result).toEqual({ message: transactionMessage(NETWORK, fields({ data: hexToBytes('0x1234') })), nonce: '0xc' })
  })

  it('needs `from` or nonce', async () => {
    const resp = await rpcTransactionMessage(req('fakereum_transactionMessage', { to: TO }), cfg, deps)
    expect(resp.error?.code).toBe(-32602)
    expect(resp.error?.message).toMatch(/from/)
  })

  it('refuses a value the message cannot express', async () => {
    const resp = await rpcTransactionMessage(req('fakereum_transactionMessage', { ...json(fields()), value: '0x1' }), cfg, deps)
    expect(resp.error?.code).toBe(-32602)
    expect(resp.error?.message).toMatch(/multiple of/)
  })
})

describe('rpcSendMessageTx', () => {
  const f = fields({ value: ETH / 1000n, data: hexToBytes('0xa9059cbb' + 'ff'.repeat(64)) })
  const params = json(f)
  const HASH = ('0x' + 'cd'.repeat(32)) as Hex

  async function signed() {
    const message = transactionMessage(NETWORK, f)
    const signature = (await account.signMessage({ message })) as Hex
    return { message, signature }
  }

  type SendDeps = Parameters<typeof rpcSendMessageTx>[2]
  const send = (p: Record<string, unknown>, over: Partial<SendDeps> = {}) =>
    rpcSendMessageTx(req('fakereum_sendTransaction', p), cfg, {
      ...deps,
      apply: async () => HASH,
      ...over,
    })

  it('recovers the signer, fills gas + fee wallet-style from the signer, and returns the executor hash', async () => {
    const { message, signature } = await signed()
    let seen: unknown = null
    const estimated: string[] = []
    const resp = await send(
      { ...params, signature },
      {
        estimateGas: async (c) => (estimated.push(`${c.from}:${c.to}:${c.value}:${c.data}`), 60000n),
        apply: async (m) => ((seen = m), HASH),
      },
    )
    expect(resp.error).toBeUndefined()
    expect(resp.result).toBe(HASH)
    const signer = account.address.toLowerCase() as Hex
    expect(estimated).toEqual([`${signer}:${TO}:${toQuantity(ETH / 1000n)}:${bytesToHex(f.data)}`])
    expect(seen).toEqual({
      ...f,
      signer,
      message,
      signature,
      gasLimit: 60000n,
      fee: { maxFeePerGas: GWEI / 10n, maxPriorityFeePerGas: 0n },
    })
  })

  it('estimates a contract creation without a `to` and hands the executor to=null', async () => {
    const create = fields({ to: null, data: hexToBytes('0x6080') })
    const signature = (await account.signMessage({ message: transactionMessage(NETWORK, create) })) as Hex
    const calls: unknown[] = []
    let m: Record<string, unknown> | null = null
    const resp = await send(
      { data: '0x6080', nonce: '0xc', signature },
      { estimateGas: async (c) => (calls.push(c), 53000n), apply: async (mm) => ((m = mm as unknown as Record<string, unknown>), HASH) },
    )
    expect(resp.error).toBeUndefined()
    expect(calls).toEqual([{ from: account.address.toLowerCase(), value: '0x0', data: '0x6080' }])
    expect(m!['to']).toBeNull()
    expect(m!['signer']).toBe(account.address.toLowerCase())
  })

  it('takes explicit gas terms from the params without touching the estimate', async () => {
    const { signature } = await signed()
    let m: Record<string, unknown> | null = null
    await send(
      { ...params, signature, gas: '0x30d40', gasPrice: toQuantity(2n * GWEI) },
      {
        estimateGas: async () => {
          throw new Error('should not estimate')
        },
        apply: async (mm) => ((m = mm as unknown as Record<string, unknown>), HASH),
      },
    )
    expect(m!['gasLimit']).toBe(200000n)
    expect(m!['fee']).toEqual({ gasPrice: 2n * GWEI })
  })

  it('insists on the nonce, since it is part of the signed text', async () => {
    const { signature } = await signed()
    const { nonce: _n, ...noNonce } = params
    const resp = await send({ ...noNonce, signature })
    expect(resp.error?.code).toBe(-32602)
    expect(resp.error?.message).toMatch(/nonce is required/)
  })

  it('tampered signed fields recover a different signer (the executor sees that address, not the wallet)', async () => {
    const { signature } = await signed()
    let signer: Hex | null = null
    await send({ ...params, nonce: '0xd', signature }, { apply: async (m) => ((signer = m.signer), HASH) })
    expect(signer).not.toBeNull()
    expect(signer!).not.toBe(account.address.toLowerCase())
  })

  it('validates the signature shape and surfaces executor errors as -32000', async () => {
    const bad = await send({ ...params, signature: '0xabcd' })
    expect(bad.error?.code).toBe(-32602)

    const { signature } = await signed()
    for (const msg of ['insufficient funds for gas * price + value', 'already known']) {
      const failed = await send(
        { ...params, signature },
        {
          apply: async () => {
            throw new Error(msg)
          },
        },
      )
      expect(failed.error?.code).toBe(-32000)
      expect(failed.error?.message).toBe(msg)
    }
  })
})

describe('render of a message tx', () => {
  // The stored raw bytes are a real 1559 tx carrying the message signature as
  // v/r/s, so the renderer's ordinary RLP path applies; the signed text rides along.
  const sig = ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as Hex
  const raw = serializeTransaction(
    {
      chainId: 42161,
      type: 'eip1559',
      nonce: 12,
      to: TO,
      value: ETH / 1000n,
      gas: 21000n,
      maxFeePerGas: GWEI / 10n,
      maxPriorityFeePerGas: 0n,
      data: '0x',
    },
    { r: ('0x' + '11'.repeat(32)) as Hex, s: ('0x' + '22'.repeat(32)) as Hex, yParity: 0 },
  )
  const tx: StoredTx = {
    hash: viemKeccak(raw),
    raw,
    type: 2,
    from: account.address.toLowerCase() as Hex,
    signedBy: account.address.toLowerCase() as Hex,
    to: TO,
    nonce: '0xc',
    value: '0x38d7ea4c68000',
    input: '0x',
    gasLimit: '0x5208',
    gasUsed: '0x5208',
    gasPrice: '0x5f5e100',
    status: 1,
    contractAddress: null,
    createdContracts: [],
    logs: [],
    blockNumber: '0x10',
    blockHash: ('0x' + 'ab'.repeat(32)) as Hex,
    blockTime: '0x1',
    seq: 0,
    signedMessage: { message: 'Fakereum Tx #12 on X\nTo: 0x…', signature: sig },
    diff: { accounts: {} },
  }

  it('reports the tx fields from the RLP and attaches the signed message', () => {
    const out = renderTx(tx)
    expect(out['chainId']).toBe('0xa4b1')
    expect(out['type']).toBe('0x2')
    expect(out['nonce']).toBe('0xc')
    expect(out['maxFeePerGas']).toBe('0x5f5e100')
    expect(out['maxPriorityFeePerGas']).toBe('0x0')
    expect(out['r']).toBe('0x' + '11'.repeat(32))
    expect(out['s']).toBe('0x' + '22'.repeat(32))
    expect(out['v']).toBe('0x1b') // viem reports v = 27 + yParity for 1559 txs, as for raw txs
    expect(out['signedMessage']).toEqual(tx.signedMessage)
    expect(out['signedBy']).toBeUndefined()
    const rc = renderReceipt(tx)
    expect(rc['effectiveGasPrice']).toBe('0x5f5e100')
    expect(rc['signedMessage']).toEqual(tx.signedMessage)
  })
})
