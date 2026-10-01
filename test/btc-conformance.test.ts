// Checks the signature-hash and input-verification code against vectors that
// were produced by other implementations:
//   - fixtures/core-sighash.json: Bitcoin Core src/test/data/sighash.json
//     (legacy sighash), minus the vectors whose script contains
//     OP_CODESEPARATOR, which only matters for scripts we never build.
//   - fixtures/bip341-wallet-test-vectors.json: BIP341 wallet test vectors,
//     including a fully signed 9-input transaction.
//   - the BIP143 native P2WPKH and P2SH-P2WPKH worked examples (inline).

import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, reversed } from '../src/btc/bytes'
import { legacySighash, segwitV0Sighash, taprootKeyPathSighash } from '../src/btc/sighash'
import { parseTx, serializeTx, txid } from '../src/btc/tx'
import { verifyInput } from '../src/btc/verify'
import coreSighash from './fixtures/core-sighash.json'
import bip341 from './fixtures/bip341-wallet-test-vectors.json'

describe('legacy sighash (Bitcoin Core vectors)', () => {
  it('matches every parseable vector', () => {
    let checked = 0
    for (const [raw, script, idx, hashType, want] of coreSighash as [string, string, number, number, string][]) {
      let tx
      try {
        tx = parseTx(hexToBytes(raw))
      } catch {
        continue // Core's random txs include shapes (e.g. zero inputs) outside what we accept
      }
      const got = bytesToHex(reversed(legacySighash(tx, idx, hexToBytes(script), hashType)))
      expect(got).toBe(want)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })
})

describe('BIP143 worked examples', () => {
  it('native P2WPKH: sighash and the signed input verifies', () => {
    const unsigned = parseTx(
      hexToBytes(
        '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000',
      ),
    )
    const code = hexToBytes('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac')
    expect(bytesToHex(segwitV0Sighash(unsigned, 1, code, 600000000n, 1))).toBe(
      'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670',
    )

    const signed = parseTx(
      hexToBytes(
        '01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000',
      ),
    )
    const prevouts = [
      { value: 625000000n, script: hexToBytes('2103c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432ac') },
      { value: 600000000n, script: hexToBytes('00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1') },
    ]
    expect(verifyInput(signed, 1, prevouts)).toBeNull()

    // Any change to what the signature covers must break it.
    const tampered = parseTx(serializeTx(signed))
    tampered.outputs[0]!.value += 1n
    expect(verifyInput(tampered, 1, prevouts)).not.toBeNull()
    const wrongAmount = [prevouts[0]!, { ...prevouts[1]!, value: 600000001n }]
    expect(verifyInput(signed, 1, wrongAmount)).not.toBeNull()
  })

  it('P2SH-P2WPKH: sighash and the signed input verifies', () => {
    const unsigned = parseTx(
      hexToBytes(
        '0100000001db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a54770100000000feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac92040000',
      ),
    )
    const code = hexToBytes('76a91479091972186c449eb1ded22b78e40d009bdf008988ac')
    expect(bytesToHex(segwitV0Sighash(unsigned, 0, code, 1000000000n, 1))).toBe(
      '64f3b0f4dd2bb3aa1ce8566d220cc74dda9df97d8490cc81d89d735c92e59fb6',
    )

    const signed = parseTx(
      hexToBytes(
        '01000000000101db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a5477010000001716001479091972186c449eb1ded22b78e40d009bdf0089feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac02473044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622ad4010726870540656fe9dcb012103ad1d8e89212f0b92c74d23bb710c00662ad1470198ac48c43f7d6f93a2a2687392040000',
      ),
    )
    const prevouts = [{ value: 1000000000n, script: hexToBytes('a9144733f37cf4db86fbc2efed2500b4f4e49f31202387') }]
    expect(verifyInput(signed, 0, prevouts)).toBeNull()
  })
})

describe('BIP341 wallet test vectors', () => {
  const v = bip341.keyPathSpending[0]!
  const prevouts = v.given.utxosSpent.map((u) => ({
    value: BigInt(u.amountSats),
    script: hexToBytes(u.scriptPubKey),
  }))
  const unsigned = parseTx(hexToBytes(v.given.rawUnsignedTx))

  it('computes the documented sighash for every key-path input', () => {
    for (const s of v.inputSpending) {
      const want = (s as { intermediary: { sigHash: string } }).intermediary.sigHash
      const got = taprootKeyPathSighash(unsigned, s.given.txinIndex, prevouts, s.given.hashType)
      expect(bytesToHex(got!)).toBe(want)
    }
  })

  it('verifies the signed inputs and rejects a modified transaction', () => {
    const signed = parseTx(hexToBytes(v.auxiliary.fullySignedTx))
    // Same transaction body; the legacy input's scriptSig is part of the txid, so compare outputs.
    expect(signed.outputs.map((o) => [o.value, bytesToHex(o.script)])).toEqual(
      unsigned.outputs.map((o) => [o.value, bytesToHex(o.script)]),
    )
    expect(txid(parseTx(serializeTx(signed)))).toBe(txid(signed))
    const taprootIdx = v.inputSpending.map((s) => s.given.txinIndex)
    for (const i of taprootIdx) expect(verifyInput(signed, i, prevouts)).toBeNull()
    // Input 2 is a plain P2PKH spend in the same transaction.
    expect(verifyInput(signed, 2, prevouts)).toBeNull()

    // Bump the last output: SIGHASH_ALL-style inputs must stop verifying.
    const tampered = parseTx(serializeTx(signed))
    tampered.outputs[1]!.value += 1n
    const failures = taprootIdx.filter((i) => verifyInput(tampered, i, prevouts) !== null)
    expect(failures.length).toBeGreaterThan(0)
  })
})
