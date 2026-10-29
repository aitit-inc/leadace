// Workers runtime has no Stripe SDK; we post x-www-form-urlencoded directly.
// The LeadAce account's default version when this was written, pinned so a
// self-host account on an older default answers with the same shapes the
// code reads (billing periods on subscription items, invoice `payments`,
// schedule phase `duration`).
const STRIPE_API_VERSION = '2026-03-25.dahlia'

// Every attempt is bounded, so a stalled one fails instead of holding a
// webhook's transaction and lock (or a request) open; with its retries a call
// stays within about half a minute.
const STRIPE_TIMEOUT_MS = 10_000
const STRIPE_RETRIES = 2
const STRIPE_RETRY_BACKOFF_MS = 500

export type StripeResult =
  | { ok: true; data: Record<string, unknown> }
  // `unknown`: Stripe may or may not have applied it, so the caller must not
  // report it as not applied.
  | { ok: false; unknown: boolean; data: Record<string, unknown> }

// What an answer says about the request. An answer that did not come or
// could not be read (readStripeAnswer) is `null`; Stripe
// documents a 5xx as indeterminate, and a 409 as a request that collided with
// another (the same idempotency key still running, a lock).
export type StripeOutcome = 'ok' | 'failed' | 'unknown'

export function stripeOutcome(status: number | null): StripeOutcome {
  if (status === null || status === 409 || status >= 500) return 'unknown'
  return status < 300 ? 'ok' : 'failed'
}

// The rule Stripe's own libraries follow: the Stripe-Should-Retry header
// decides when present, otherwise an unknown outcome is retried.
export function shouldRetryStripe(outcome: StripeOutcome, shouldRetryHeader: string | null): boolean {
  if (shouldRetryHeader !== null) return shouldRetryHeader === 'true'
  return outcome === 'unknown'
}

// An answer counts only when it came and its body is a JSON object; anything
// else (timed out, cut off, not JSON) leaves no status the caller can trust.
export function readStripeAnswer(httpStatus: number | null, body: unknown): { status: number | null; data: Record<string, unknown> | null } {
  const readable = httpStatus !== null && typeof body === 'object' && body !== null
  return { status: readable ? httpStatus : null, data: readable ? (body as Record<string, unknown>) : null }
}

type Attempt = { status: number | null; shouldRetry: string | null; data: Record<string, unknown> | null }

async function attempt(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: Record<string, string> | null,
  secretKey: string,
  idempotencyKey: string | null,
): Promise<Attempt> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  }).catch(() => null)
  const answered: unknown = res ? await res.json().catch(() => null) : null
  return { ...readStripeAnswer(res?.status ?? null, answered), shouldRetry: res?.headers.get('Stripe-Should-Retry') ?? null }
}

// A POST carries one idempotency key across its attempts, so Stripe applies it
// once and answers a repeat with the first result; GET and DELETE are
// idempotent already.
export async function stripeApiRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: Record<string, string> | null,
  secretKey: string,
): Promise<StripeResult> {
  const idempotencyKey = method === 'POST' ? crypto.randomUUID() : null
  let last = await attempt(method, path, body, secretKey, idempotencyKey)
  for (let retry = 1; retry <= STRIPE_RETRIES && shouldRetryStripe(stripeOutcome(last.status), last.shouldRetry); retry++) {
    await new Promise((resolve) => setTimeout(resolve, STRIPE_RETRY_BACKOFF_MS * retry))
    last = await attempt(method, path, body, secretKey, idempotencyKey)
  }
  const outcome = stripeOutcome(last.status)
  if (outcome === 'ok' && last.data) return { ok: true, data: last.data }
  const data = last.data ?? {
    error: { type: 'api_error', code: 'unreadable_response', message: 'Stripe did not answer, or its answer could not be read' },
  }
  return { ok: false, unknown: outcome === 'unknown', data }
}

export function stripeErrorCode(data: Record<string, unknown>): unknown {
  return (data['error'] as { code?: unknown } | undefined)?.code
}
