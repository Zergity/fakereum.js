// BtcSandbox — the Bitcoin counterpart of EvmSandbox. One instance per
// deployment, holding the sandbox chain in memory and its rows in DO storage.
// Everything interesting lives in BtcNode; this class only supplies storage and
// config, and hydrates persisted state before the first request is served.

import type { Env } from '../types'
import { loadBtcConfig } from './config'
import { EsploraUpstream } from './esplora'
import { BtcNode, type BtcStorage } from './node'

export class BtcSandbox {
  private readonly node: BtcNode

  constructor(ctx: DurableObjectState, env: Env) {
    const cfg = loadBtcConfig(env)
    const storage: BtcStorage = {
      get: <T>(key: string) => ctx.storage.get<T>(key),
      put: (entries) => ctx.storage.put(entries),
      list: <T>(prefix: string) => ctx.storage.list<T>({ prefix }),
      delete: async (keys) => {
        await ctx.storage.delete(keys)
      },
    }
    this.node = new BtcNode(storage, cfg, new EsploraUpstream(cfg.upstreamEsplora, cfg.upstreamTimeoutMs))
  }

  fetch(request: Request): Promise<Response> {
    return this.node.handle(request)
  }
}
