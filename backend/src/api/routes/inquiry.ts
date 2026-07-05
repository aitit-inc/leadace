import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { createDb } from '../../db/connection'
import { authMiddleware } from '../middleware/auth'
import { rlsMiddleware } from '../middleware/rls'
import { inquiryShortIdParamSchema } from '../../services/inquiry-token'
import {
  inquiryUnsubscribeBodySchema,
  inquiryRequestMeetingBodySchema,
  inquiryChatMessageBodySchema,
  inquiryPreviewQuerySchema,
  loadLandingContext,
  loadPreviewContext,
  recordMeetingRequest,
  recordSignupClick,
  recordInquiryUnsubscribe,
} from '../../services/inquiry-session'
import { runInquiryChat } from '../../services/inquiry-chat'
import {
  inquiryPreviewChatBodySchema,
  runInquiryPreviewChat,
} from '../../services/inquiry-preview-chat'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

// Public, unauthenticated landing routes — the DB-backed short_id in the
// URL IS the auth, so handlers use raw `createDb()` and bypass RLS, same
// pattern as `unsubscribe.ts`. Sender-facing sub-routes attach authMiddleware
// + rlsMiddleware inline so this whole router can sit outside the global
// /api/* auth block in api/index.ts.

export const inquiryRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

inquiryRouter.get(
  '/inquiry/preview',
  authMiddleware,
  rlsMiddleware,
  zValidator('query', inquiryPreviewQuerySchema),
  async (c) => {
    const result = await loadPreviewContext(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('query').projectId,
      c.req.valid('query').prospectId ?? null,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

// Stateless sender-side preview chat — writes nothing. Registered before the
// public `/inquiry/:shortId/message` route so `preview` isn't captured as a
// shortId.
inquiryRouter.post(
  '/inquiry/preview/message',
  authMiddleware,
  rlsMiddleware,
  zValidator('json', inquiryPreviewChatBodySchema),
  async (c) => {
    const result = await runInquiryPreviewChat(
      c.get('db'),
      { OPENAI_API_KEY: c.env.OPENAI_API_KEY },
      c.get('tenantId'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

inquiryRouter.get(
  '/inquiry/:shortId',
  zValidator('param', inquiryShortIdParamSchema),
  async (c) => {
    const db = createDb(c.env.DATABASE_URL)
    const result = await loadLandingContext(db, c.req.valid('param').shortId)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

inquiryRouter.post(
  '/inquiry/:shortId/unsubscribe',
  zValidator('param', inquiryShortIdParamSchema),
  zValidator('json', inquiryUnsubscribeBodySchema),
  async (c) => {
    const db = createDb(c.env.DATABASE_URL)
    const result = await recordInquiryUnsubscribe(
      db,
      c.req.valid('param').shortId,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

inquiryRouter.post(
  '/inquiry/:shortId/request-meeting',
  zValidator('param', inquiryShortIdParamSchema),
  zValidator('json', inquiryRequestMeetingBodySchema),
  async (c) => {
    const db = createDb(c.env.DATABASE_URL)
    const result = await recordMeetingRequest(
      db,
      c.req.valid('param').shortId,
      'button',
      c.req.valid('json').note ?? null,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

inquiryRouter.post(
  '/inquiry/:shortId/signup-click',
  zValidator('param', inquiryShortIdParamSchema),
  async (c) => {
    const db = createDb(c.env.DATABASE_URL)
    const result = await recordSignupClick(db, c.req.valid('param').shortId)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

inquiryRouter.post(
  '/inquiry/:shortId/message',
  zValidator('param', inquiryShortIdParamSchema),
  zValidator('json', inquiryChatMessageBodySchema),
  async (c) => {
    const db = createDb(c.env.DATABASE_URL)
    const result = await runInquiryChat(
      db,
      {
        OPENAI_API_KEY: c.env.OPENAI_API_KEY,
        GOOGLE_CLIENT_ID: c.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: c.env.GOOGLE_CLIENT_SECRET,
        GMAIL_TOKEN_ENCRYPTION_KEY: c.env.GMAIL_TOKEN_ENCRYPTION_KEY,
        APP_URL: c.env.APP_URL,
        E2E_RECIPIENT_OVERRIDE: c.env.E2E_RECIPIENT_OVERRIDE,
      },
      c.get('edition'),
      c.req.valid('param').shortId,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
