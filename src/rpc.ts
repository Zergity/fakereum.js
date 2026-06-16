// JSON-RPC envelope types + helpers. Mirrors rpc.go. The `id` is round-tripped
// verbatim (number, string, or null) exactly as received.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue }

export type RpcId = string | number | null

export interface RpcRequest {
  jsonrpc?: string
  id?: RpcId
  method: string
  params?: unknown
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id?: RpcId
  result?: unknown
  error?: RpcError
}

// Standard JSON-RPC + geth error codes used across fakereum.
export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603
export const ERR_SERVER = -32000 // generic server error (geth uses this for tx/exec failures)
export const ERR_EXECUTION_REVERTED = 3 // geth: execution reverted (data carries return bytes)

export function makeResult(id: RpcId | undefined, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

export function makeError(
  id: RpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  const err: RpcError = { code, message }
  if (data !== undefined) err.data = data
  return { jsonrpc: '2.0', id: id ?? null, error: err }
}

/** Coerce a parsed body into a params array (params may be omitted/object). */
export function paramsArray(params: unknown): unknown[] {
  if (Array.isArray(params)) return params
  if (params == null) return []
  return [params]
}

/** True when a parsed JSON body is a JSON-RPC batch (array of requests). */
export function isBatch(body: unknown): body is RpcRequest[] {
  return Array.isArray(body)
}
