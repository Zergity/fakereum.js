import { describe, expect, it } from 'vitest'
import { NETWORKS } from '../src/btc/address'
import { verifyBip322 } from '../src/btc/bip322'
import { alice, bob, signBip322 } from './btc-helpers'

const net = NETWORKS.mainnet

describe('BIP-322 simple', () => {
  // Test vector from the BIP: address bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l.
  const addr = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
  const empty =
    'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='

  it('accepts the specification vector (empty message)', () => {
    expect(verifyBip322(addr, net, '', empty)).toBeNull()
  })

  it('rejects a signature for another message or another address', () => {
    expect(verifyBip322(addr, net, 'Hello World', empty)).not.toBeNull()
    expect(verifyBip322(alice.address, net, '', empty)).not.toBeNull()
  })

  it('round-trips a signature made by a test key', () => {
    const sig = signBip322(alice, 'hello sandbox')
    expect(verifyBip322(alice.address, net, 'hello sandbox', sig)).toBeNull()
    expect(verifyBip322(bob.address, net, 'hello sandbox', sig)).not.toBeNull()
    expect(verifyBip322(alice.address, net, 'hello sandbox ', sig)).not.toBeNull()
  })

  it('reports malformed input instead of throwing', () => {
    expect(verifyBip322(alice.address, net, 'm', '!!!')).toMatch(/malformed|invalid/i)
    expect(verifyBip322('nonsense', net, 'm', 'AA==')).toMatch(/invalid/)
  })
})
