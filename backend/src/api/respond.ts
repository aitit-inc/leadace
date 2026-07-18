import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ServiceError, ServiceErrorCode } from '../services/result'

const STATUS_BY_CODE: Record<ServiceErrorCode, ContentfulStatusCode> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
}

// Lives under `api/` because services are HTTP-agnostic and must not import `hono`.
// `extra` flows through verbatim so endpoints can surface partial-result context
// on a pre-flight refusal (see batch register).
export function respondWithError(c: Context, e: ServiceError) {
  const body: Record<string, unknown> = { error: e.error }
  if (e.detail !== undefined) body.detail = e.detail
  if (e.extra) Object.assign(body, e.extra)
  return c.json(body, STATUS_BY_CODE[e.code])
}
