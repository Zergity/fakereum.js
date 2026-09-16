// Per-account nonce allocation for signed-message transactions.
//
// A sandbox has no mempool: fakereum_sendTransaction executes on arrival and
// the signed nonce must equal the account's current one. fakereum_transactionMessage
// reads that nonce when it builds the text, so two sends started together both
// read N, the user signs both, and whichever lands second is rejected for
// reusing a nonce. Signing is a human round trip, so the window is seconds
// wide — wide enough that any dapp doing approve-then-swap hits it.
//
// This closes it client-side, in two stages per account:
//
//   sign    one at a time. The nonce is taken as max(what the sandbox reports,
//           one past the highest nonce signed here) and counted as spent the
//           moment the wallet hands back a well-formed signature — not when the
//           transaction lands. So the next send is prompted for while the
//           previous one is still executing, instead of after it.
//   submit  in signing order, one at a time, because nonce N+1 cannot land
//           before N does.
//
// Nothing is spent until a signature exists: a cancelled or malformed signature
// leaves the nonce for the next send. Different accounts never wait on each other.
//
// The spent count is a hint, not a source of truth: another client (or
// fakereum_clearSandbox) can move the account out from under it, and a submit
// that fails did not consume its nonce. Either way the hint is dropped and the
// next send re-reads from the sandbox; reset() does the same on demand.

import { ProviderRpcError, rpc } from './rpc'
import { toBigInt, toQuantity, type Hex } from './hex'

export interface NonceManagerOptions {
  /** Read an account's next nonce. Default: eth_getTransactionCount(address, 'pending') on the sandbox. */
  getNonce?: (address: string) => Promise<bigint>
}

export interface NonceSteps<T> {
  /** Have the wallet sign the message for `nonce`; resolves to the 65-byte signature. */
  sign: (nonce: Hex) => Promise<string>
  /** POST the signed transaction. Runs behind everything signed for this account before it. */
  submit: (nonce: Hex, signature: Hex) => Promise<T>
}

export interface NonceManager {
  /**
   * Sign and submit one transaction for `from`. `sign` runs under the account's
   * signing lock with a nonce nothing else is using; the lock is released, and
   * the nonce counted as spent, as soon as it returns a valid signature.
   * `explicit` (a caller-supplied tx.nonce) is used as-is instead of an
   * allocated one, and still takes both queues in turn.
   */
  signAndSend<T>(from: string, steps: NonceSteps<T>, explicit?: bigint | number | string | null): Promise<T>
  /** The nonce the next send would use, as far as this manager knows — undefined until one is signed. */
  peek(address: string): bigint | undefined
  /** Forget what has been spent, for one account or all of them; the next send re-reads from the sandbox. */
  reset(address?: string): void
}

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/
const RESOLVED: Promise<void> = Promise.resolve()

/** Whether an error is the sandbox (or a node) complaining about the nonce. */
export function isNonceError(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? '')
  return /correct nonce|nonce too (low|high)|invalid nonce|nonce has already been used/i.test(msg)
}

export function createNonceManager(rpcUrl: string, opts: NonceManagerOptions = {}): NonceManager {
  const read = opts.getNonce ?? ((a: string) => rpc<Hex>(rpcUrl, 'eth_getTransactionCount', [a, 'pending']).then((n) => toBigInt(n)))

  /** One past the highest nonce signed here, per lowercased address. */
  const spent = new Map<string, bigint>()
  /** Tails of the two per-account queues. Neither ever rejects. */
  const signing = new Map<string, Promise<void>>()
  const submitting = new Map<string, Promise<void>>()

  /** Append to a queue, and forget it once it is the tail and has settled. */
  const enqueue = (queue: Map<string, Promise<void>>, key: string, task: Promise<unknown>): void => {
    const tail = task.then(
      () => {},
      () => {},
    )
    queue.set(key, tail)
    void tail.then(() => {
      if (queue.get(key) === tail) queue.delete(key)
    })
  }

  const allocate = async (key: string, from: string): Promise<bigint> => {
    const chain = await read(from)
    const hint = spent.get(key)
    return hint !== undefined && hint > chain ? hint : chain
  }

  const signAndSend = <T>(from: string, steps: NonceSteps<T>, explicit?: bigint | number | string | null): Promise<T> => {
    const key = from.toLowerCase()

    // Stage 1 — allocate and sign. Nothing else for this account signs meanwhile.
    const signed = (signing.get(key) ?? RESOLVED).then(async () => {
      const nonce = explicit === undefined || explicit === null || explicit === '' ? await allocate(key, from) : toBigInt(explicit)
      const signature = await steps.sign(toQuantity(nonce))
      if (!SIGNATURE_RE.test(signature)) {
        throw new ProviderRpcError(-32603, `the wallet returned a malformed signature for nonce ${nonce}; expected 65 bytes of 0x-hex`)
      }
      const next = nonce + 1n
      const hint = spent.get(key)
      if (hint === undefined || next > hint) spent.set(key, next)
      return { nonce, signature: signature as Hex }
    })
    enqueue(signing, key, signed)

    // Stage 2 — submit, behind whatever was signed for this account before this
    // call. The slot is taken now, so submits run in signing order; a send that
    // is never signed passes its turn on instead of holding it.
    const prev = submitting.get(key) ?? RESOLVED
    const result = (async () => {
      const { nonce, signature } = await signed
      await prev
      try {
        return await steps.submit(toQuantity(nonce), signature)
      } catch (e) {
        // It did not land, so its nonce is still free — and anything already
        // signed behind it is now out of step. Re-read for the next one.
        spent.delete(key)
        throw e
      }
    })()
    enqueue(submitting, key, result)
    return result
  }

  return {
    signAndSend,
    peek: (address) => spent.get(address.toLowerCase()),
    reset: (address) => {
      if (address === undefined) spent.clear()
      else spent.delete(address.toLowerCase())
    },
  }
}
