// HTTP-agnostic. Services return semantic codes; `api/respond.ts` maps them
// to status codes and JSON bodies.
export type ServiceErrorCode =
  | 'INVALID_INPUT'        // 400 — body validation, malformed id
  | 'FORBIDDEN'            // 403 — quota/policy refusal
  | 'NOT_FOUND'            // 404
  | 'CONFLICT'             // 409 — state-mismatch on write
  | 'PRECONDITION_FAILED'  // 412 — e.g. Gmail not connected
  | 'UNPROCESSABLE'        // 422 — semantically invalid (DNC, missing channel)
  | 'INTERNAL_ERROR'       // 500 — non-programming failures the route
                           // can't recover from (Stripe checkout/portal create
                           // failure, etc.). Programming bugs should throw and
                           // let Hono's onError surface a generic 500.
  | 'BAD_GATEWAY'          // 502 — upstream service returned an error after
                           // we successfully reached it (Gmail send rejected,
                           // etc.). Distinct from INTERNAL_ERROR so callers
                           // can tell "their service" from "ours".

export type ServiceError = {
  ok: false
  code: ServiceErrorCode
  error: string
  // `unknown` so legacy responses passing a third-party body (e.g. Stripe's
  // JSON payload) flow through verbatim.
  detail?: unknown
  // Escape hatch: extra fields merged into the JSON body by `respondWithError`.
  // For endpoints whose error shape carries diagnostic context beyond
  // `{error, detail}` (e.g. partial results on a pre-flight refusal).
  extra?: Record<string, unknown>
}

export type ServiceResult<T> = { ok: true; value: T } | ServiceError

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value }
}

// Returns `ServiceError` (not `ServiceResult<never>`) so routes can pass the
// result directly to `respondWithError` without narrowing.
export function err(
  code: ServiceErrorCode,
  error: string,
  detail?: unknown,
  extra?: Record<string, unknown>,
): ServiceError {
  const e: ServiceError = { ok: false, code, error }
  if (detail !== undefined) e.detail = detail
  if (extra !== undefined) e.extra = extra
  return e
}
