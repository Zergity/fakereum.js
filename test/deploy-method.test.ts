import { describe, expect, it } from 'vitest'
import { createVM } from '@ethereumjs/vm'
import { Hardfork, Mainnet, createCustomCommon } from '@ethereumjs/common'
import { bigIntToBytes, createAddressFromString, generateAddress } from '@ethereumjs/util'
import { captureDeployMethods, classifyDeploy } from '../src/executor'
import { resolveDeployMethod } from '../src/lib/deploy'
import { bytesToHex, hexToBytes } from '../src/lib/hex'
import type { StoredTx } from '../src/types'

describe('classifyDeploy', () => {
  it('labels a top-level zero-address tx deploy as "tx"', () => {
    expect(classifyDeploy(0, false)).toBe('tx')
  })
  it('labels an internal CREATE opcode as "create"', () => {
    expect(classifyDeploy(1, false)).toBe('create')
    expect(classifyDeploy(3, false)).toBe('create')
  })
  it('labels a salted deploy as "create2" regardless of depth', () => {
    expect(classifyDeploy(1, true)).toBe('create2')
    expect(classifyDeploy(0, true)).toBe('create2')
  })
})

describe('resolveDeployMethod (reconstruction for uncaptured txs)', () => {
  const DEPLOYER = '0x' + '22'.repeat(20)
  // CREATE address the deployer produces at nonce 1 (its first internal create).
  const createChild = bytesToHex(generateAddress(hexToBytes(DEPLOYER), bigIntToBytes(1n)))
  const create2Child = '0x' + 'cd'.repeat(20) // any salt-based address (no nonce match)

  // Minimal StoredTx: the resolver only reads createdVia, contractAddress, and
  // diff.accounts[*].{nonceChanged,preNonce,postNonce}.
  function txFixture(over: Partial<StoredTx>): StoredTx {
    return {
      contractAddress: null,
      createdVia: undefined,
      diff: {
        accounts: {
          [DEPLOYER.toLowerCase()]: { nonceChanged: true, preNonce: '0x1', postNonce: '0x2' },
        },
      },
      ...over,
    } as unknown as StoredTx
  }

  it('prefers the captured method when present', () => {
    const tx = txFixture({ createdVia: { [create2Child]: 'create' } })
    expect(resolveDeployMethod(tx, create2Child)).toBe('create')
  })

  it('labels the top-level (zero-`to` tx) contract as a CREATE ("tx")', () => {
    const c = '0x' + 'ab'.repeat(20)
    const tx = txFixture({ contractAddress: c as StoredTx['contractAddress'] })
    expect(resolveDeployMethod(tx, c)).toBe('tx')
  })

  it('reconstructs an internal CREATE from a nonce-based address match', () => {
    const tx = txFixture({})
    expect(resolveDeployMethod(tx, createChild)).toBe('create')
  })

  it('reconstructs CREATE2 when no nonce derivation matches', () => {
    const tx = txFixture({})
    expect(resolveDeployMethod(tx, create2Child)).toBe('create2')
  })
})

describe('captureDeployMethods (live EVM)', () => {
  it('captures top-level tx, internal CREATE, and internal CREATE2 in one tx', async () => {
    const common = createCustomCommon({ chainId: 1 }, Mainnet, { hardfork: Hardfork.Cancun })
    const vm = await createVM({ common })
    const via = captureDeployMethods(vm)

    // Init code for a top-level (zero-`to`) deploy whose constructor:
    //   1. CREATE  a child  (init code = the single STOP byte read from zeroed memory)
    //   2. CREATE2 a child  (salt 0x1234, same init code)
    //   3. RETURN 1 byte of runtime so the top-level contract has code.
    //   6001 6000 6000 f0 50            CREATE(value=0, off=0, size=1); POP
    //   611234 6001 6000 6000 f5 50     CREATE2(value=0, off=0, size=1, salt=0x1234); POP
    //   6001 6000 f3                    RETURN(off=0, size=1)
    const initcode = '0x600160006000f050611234600160006000f55060016000f3'
    const caller = createAddressFromString('0x' + '11'.repeat(20))

    const res = await vm.evm.runCall({
      caller,
      to: undefined, // contract creation (zero-address tx)
      data: hexToBytes(initcode),
      gasLimit: 10_000_000n,
      depth: 0,
      skipBalance: true,
    })
    expect(res.execResult.exceptionError).toBeUndefined()

    // Three distinct contracts deployed, one of each mechanism.
    const methods = [...via.values()].sort()
    expect(methods).toEqual(['create', 'create2', 'tx'])
  })
})
