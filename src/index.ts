// Front Worker entry. Deliberately thin: a plain Worker request on the Free
// plan is capped at 10ms CPU — far too little for the EVM — so this just
// forwards everything into a sandbox Durable Object, which gets a 30s CPU
// budget on every plan (Free included) and owns all state + execution.
//
// One Worker per deployment (one upstream -> one sandbox chain), so a fixed DO
// name is used. The DO reads its config from `env` in its constructor. A
// deployment binds exactly one of EVM_SANDBOX (an EVM chain) or BTC_SANDBOX (a
// Bitcoin chain); both classes are exported so the shared migration list in
// wrangler.toml resolves in every environment.

import { EvmSandbox } from './do/sandbox_do'
import { BtcSandbox } from './btc/sandbox_do'
import type { Env } from './types'

export { EvmSandbox, BtcSandbox }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ns = env.BTC_SANDBOX ?? env.EVM_SANDBOX
    if (!ns) {
      return new Response('no sandbox Durable Object binding (EVM_SANDBOX or BTC_SANDBOX)', { status: 500 })
    }
    const id = ns.idFromName('fakereum')
    const stub = ns.get(id)
    return stub.fetch(request)
  },
}
