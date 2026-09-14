// A JSON-RPC POST helper and the EIP-1193 shapes the SDK speaks.

export interface RequestArguments {
  method: string
  params?: unknown[] | Record<string, unknown>
}

export interface EIP1193Provider {
  request(args: RequestArguments): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Error shape wallets throw (EIP-1193 ProviderRpcError). */
export class ProviderRpcError extends Error {
  code: number
  data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'ProviderRpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** POST one JSON-RPC call to `url`; resolves the result or throws a ProviderRpcError. */
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!r.ok) throw new ProviderRpcError(-32603, `${method}: HTTP ${r.status}`)
  const j = (await r.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } }
  if (j.error) throw new ProviderRpcError(j.error.code ?? -32603, j.error.message ?? `${method} failed`, j.error.data)
  return j.result as T
}

/** Build a `request`-shaped function over either a URL or an EIP-1193 provider. */
export function requester(target: string | EIP1193Provider): (method: string, params?: unknown[]) => Promise<unknown> {
  if (typeof target === 'string') return (method, params = []) => rpc(target, method, params)
  return (method, params = []) => target.request({ method, params })
}
