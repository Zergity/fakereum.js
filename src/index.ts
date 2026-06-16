// Front Worker entry. Deliberately thin: a plain Worker request on the Free
// plan is capped at 10ms CPU — far too little for the EVM — so this just
// forwards everything into the EvmSandbox Durable Object, which gets a 30s CPU
// budget on every plan (Free included) and owns all state + execution.
//
// One sandbox per deployment (one upstream -> one sandbox chain id), so a fixed
// DO name is used. The DO reads its config from `env` in its constructor.

import { EvmSandbox } from './do/sandbox_do'
import type { Env } from './types'

export { EvmSandbox }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.EVM_SANDBOX) {
      return new Response('EVM_SANDBOX Durable Object binding missing', { status: 500 })
    }
    const id = env.EVM_SANDBOX.idFromName('fakereum')
    const stub = env.EVM_SANDBOX.get(id)
    return stub.fetch(request)
  },
}
