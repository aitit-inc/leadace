import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '../zvalidator'
import { createDb } from '../../db/connection'
import {
  InvalidUnsubscribeTokenError,
  verifyUnsubscribeToken,
  type UnsubscribeTokenPayload,
} from '../../auth/unsubscribe-token'
import {
  unsubscribeTokenParamSchema,
  withReasonBodySchema,
  getUnsubscribeInfo,
  markUnsubscribed,
  recordUnsubscribeWithReason,
} from '../../services/unsubscribe'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

// Public, unauthenticated unsubscribe routes. The HMAC token in the URL is
// the auth — anyone holding a valid token can flip do_not_contact for that
// prospect. No user session, no RLS (we use createDb() directly to bypass).
//
// Mounted BEFORE the /api/* auth middleware. UX:
//   GET  /api/unsubscribe/:token              -> returns prospect summary for confirmation page
//   POST /api/unsubscribe/:token              -> sets do_not_contact=true (idempotent, RFC 8058 one-click target)
//   POST /api/unsubscribe/:token/with-reason  -> same DNC ratchet PLUS records a structured rejection
//                                                 (responses + rejection_feedback) for /check-feedback aggregation.

export const unsubscribeRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// Returns the verified payload or a ready-to-return 400 Response. Centralizes
// the InvalidUnsubscribeTokenError → 400 mapping that all three handlers share.
async function verifyTokenOrFail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  token: string,
): Promise<UnsubscribeTokenPayload | Response> {
  try {
    return await verifyUnsubscribeToken(token, c.env.UNSUBSCRIBE_TOKEN_SECRET)
  } catch (e) {
    if (e instanceof InvalidUnsubscribeTokenError) {
      return c.json({ error: 'Invalid or tampered unsubscribe link' }, 400)
    }
    throw e
  }
}

unsubscribeRouter.get(
  '/unsubscribe/:token',
  zValidator('param', unsubscribeTokenParamSchema),
  async (c) => {
    const verified = await verifyTokenOrFail(c, c.req.valid('param').token)
    if (verified instanceof Response) return verified

    const db = createDb(c.env.DATABASE_URL)
    const result = await getUnsubscribeInfo(db, verified.prospectId)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

unsubscribeRouter.post(
  '/unsubscribe/:token',
  zValidator('param', unsubscribeTokenParamSchema),
  async (c) => {
    const verified = await verifyTokenOrFail(c, c.req.valid('param').token)
    if (verified instanceof Response) return verified

    const db = createDb(c.env.DATABASE_URL)
    const result = await markUnsubscribed(db, verified.prospectId)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

unsubscribeRouter.post(
  '/unsubscribe/:token/with-reason',
  zValidator('param', unsubscribeTokenParamSchema),
  zValidator('json', withReasonBodySchema),
  async (c) => {
    const verified = await verifyTokenOrFail(c, c.req.valid('param').token)
    if (verified instanceof Response) return verified

    const db = createDb(c.env.DATABASE_URL)
    const result = await recordUnsubscribeWithReason(db, verified.prospectId, c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
