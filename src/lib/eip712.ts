// EIP-712 digests + signer recovery for the admin-gated mutations
// (fakereum_setImpersonator / removeImpersonator / clearSandbox).
//
// The digests are built by hand to match the Go impl byte-for-byte
// (impersonate_rpc.go + clear_sandbox.go): a shared domain
//   EIP712Domain(string name,string version,uint256 chainId)
//   name="fakereum-impersonate", version="1", chainId=<sandbox id>
// Recovery uses viem.recoverAddress (noble-backed, Workers-safe) so we don't
// chase @noble/curves' version-specific recover API.

import { recoverAddress } from 'viem'
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  keccak256,
  toAddress,
  type Hex,
} from './hex'

const utf8 = (s: string) => new TextEncoder().encode(s)

const DOMAIN_TYPE_HASH = keccak256(
  utf8('EIP712Domain(string name,string version,uint256 chainId)'),
)
const DOMAIN_NAME_HASH = keccak256(utf8('fakereum-impersonate'))
const DOMAIN_VERSION_HASH = keccak256(utf8('1'))

const SET_IMP_TYPE_HASH = keccak256(
  utf8('SetImpersonator(address impersonator,address impersonatee)'),
)
const REMOVE_IMP_TYPE_HASH = keccak256(utf8('RemoveImpersonator(address impersonator)'))
const CLEAR_TYPE_HASH = keccak256(
  utf8('ClearSandbox(address[] include,address[] exclude,bool keepNonzeroNonce)'),
)
const SET_CODE_TYPE_HASH = keccak256(utf8('SetCode(address account,bytes code)'))

/** 32-byte big-endian encoding of a uint256. */
function uint256To32(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Zero-left-pad a 20-byte address into a 32-byte slot. */
function addressTo32(addr: Hex): Uint8Array {
  const out = new Uint8Array(32)
  out.set(hexToBytes(toAddress(addr)), 12)
  return out
}

function domainSeparator(chainId: bigint): Uint8Array {
  return keccak256(
    concatBytes(DOMAIN_TYPE_HASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, uint256To32(chainId)),
  )
}

/** keccak256("\x19\x01" || domainSep || structHash) -> 0x-hex digest. */
function digest(chainId: bigint, structHash: Uint8Array): Hex {
  return bytesToHex(
    keccak256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator(chainId), structHash)),
  )
}

/** EIP-712 dynamic address[] hash: keccak of the 32-byte-padded elements. */
function addressArrayHash(addrs: Hex[]): Uint8Array {
  return keccak256(concatBytes(...addrs.map(addressTo32)))
}

export function setImpersonatorDigest(chainId: bigint, impersonator: Hex, impersonatee: Hex): Hex {
  const structHash = keccak256(
    concatBytes(SET_IMP_TYPE_HASH, addressTo32(impersonator), addressTo32(impersonatee)),
  )
  return digest(chainId, structHash)
}

export function removeImpersonatorDigest(chainId: bigint, impersonator: Hex): Hex {
  const structHash = keccak256(concatBytes(REMOVE_IMP_TYPE_HASH, addressTo32(impersonator)))
  return digest(chainId, structHash)
}

export function clearSandboxDigest(
  chainId: bigint,
  include: Hex[],
  exclude: Hex[],
  keepNonzeroNonce: boolean,
): Hex {
  // A wallet encodes an EIP-712 `bool` as a uint256 (0 or 1) in the last slot,
  // so we hash the same 32-byte value here.
  const structHash = keccak256(
    concatBytes(
      CLEAR_TYPE_HASH,
      addressArrayHash(include),
      addressArrayHash(exclude),
      uint256To32(keepNonzeroNonce ? 1n : 0n),
    ),
  )
  return digest(chainId, structHash)
}

/**
 * Digest for the admin bytecode-replace action. `code` is an EIP-712 dynamic
 * `bytes`, so it hashes to keccak256(code) — matching what a wallet's
 * eth_signTypedData_v4 computes for the SetCode(address account,bytes code) type.
 */
export function setCodeDigest(chainId: bigint, account: Hex, code: Uint8Array): Hex {
  const structHash = keccak256(
    concatBytes(SET_CODE_TYPE_HASH, addressTo32(account), keccak256(code)),
  )
  return digest(chainId, structHash)
}

/**
 * Recover the signer address from a 65-byte signature over the digest. viem
 * normalizes v in {0,1,27,28}; we just validate length. Returns the
 * checksummed signer, or throws on a malformed signature.
 */
export async function recoverEIP712Signer(digestHex: Hex, signature: Hex): Promise<Hex> {
  const sig = hexToBytes(signature)
  if (sig.length !== 65) throw new Error(`expected 65-byte signature, got ${sig.length}`)
  const addr = await recoverAddress({ hash: digestHex, signature })
  return toAddress(addr)
}
