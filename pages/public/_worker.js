// Cloudflare Pages advanced-mode entry, shared by every per-chain Pages
// project (pages/<chainid>/wrangler.toml).
//
// Pages cannot define or host a Durable Object, so each project is a thin
// forwarder — identical in spirit to ../../src/index.ts. Every request is
// handed to the EvmSandbox Durable Object, which lives in that chain's
// companion Worker `fakereum-<chainid>-rpc` (bound here as EVM_SANDBOX via
// `script_name` in the project's wrangler.toml). The DO runs the EVM and
// serves the landing page (GET /) and JSON-RPC (POST /rpc).
//
// The DO name ('fakereum') matches src/index.ts, so requests arriving via the
// Worker's own *.workers.dev host and via the Pages host hit the SAME DO
// instance and share state.
export default {
  async fetch(request, env) {
    if (!env.EVM_SANDBOX) {
      return new Response('EVM_SANDBOX Durable Object binding missing', { status: 500 });
    }
    const id = env.EVM_SANDBOX.idFromName('fakereum');
    return env.EVM_SANDBOX.get(id).fetch(request);
  },
};
