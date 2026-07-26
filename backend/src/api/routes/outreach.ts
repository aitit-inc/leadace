import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  outreachLogIdParamSchema,
  recentOutreachQuerySchema,
  recordOutreach,
  recordOutreachSchema,
  skipProspect,
  skipProspectSchema,
  recordOutreachWithInquiry,
  recordOutreachWithInquirySchema,
  updateOutreachStatus,
  updateOutreachStatusSchema,
  sendAndRecord,
  sendAndRecordSchema,
  listRecentOutreach,
  listOutreachResponses,
  listDrafts,
  listDraftsQuerySchema,
  editDraft,
  editDraftSchema,
  sendDraft,
  previewDraft,
  markDraftSent,
  discardDraft,
  discardDrafts,
  discardDraftsBodySchema,
  type SendContext,
} from '../../services/outreach'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'
import type { Context } from 'hono'

export const outreachRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

outreachRouter.post('/outreach', zValidator('json', recordOutreachSchema), async (c) => {
  const result = await recordOutreach(
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

outreachRouter.post('/outreach/skip', zValidator('json', skipProspectSchema), async (c) => {
  const result = await skipProspect(c.get('db'), c.get('tenantId'), c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

outreachRouter.post(
  '/outreach/send-and-record',
  zValidator('json', sendAndRecordSchema),
  async (c) => {
    const result = await sendAndRecord(
      c.get('db'),
      c.get('tenantId'),
      c.get('edition'),
      sendContext(c),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)

outreachRouter.post(
  '/outreach/record-with-inquiry',
  zValidator('json', recordOutreachWithInquirySchema),
  async (c) => {
    const result = await recordOutreachWithInquiry(
      c.get('db'),
      c.get('tenantId'),
      c.get('edition'),
      sendContext(c),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)

outreachRouter.patch(
  '/outreach/:id/status',
  zValidator('param', outreachLogIdParamSchema),
  zValidator('json', updateOutreachStatusSchema),
  async (c) => {
    const result = await updateOutreachStatus(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.get(
  '/projects/:id/outreach/recent',
  zValidator('param', projectRefParamSchema),
  zValidator('query', recentOutreachQuerySchema),
  async (c) => {
    const result = await listRecentOutreach(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.get(
  '/outreach/:id/responses',
  zValidator('param', outreachLogIdParamSchema),
  async (c) => {
    const result = await listOutreachResponses(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.get(
  '/projects/:id/drafts',
  zValidator('param', projectRefParamSchema),
  zValidator('query', listDraftsQuerySchema),
  async (c) => {
    const result = await listDrafts(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.put(
  '/outreach/drafts/:id',
  zValidator('param', outreachLogIdParamSchema),
  zValidator('json', editDraftSchema),
  async (c) => {
    const result = await editDraft(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.post(
  '/outreach/drafts/:id/send',
  zValidator('param', outreachLogIdParamSchema),
  async (c) => {
    const result = await sendDraft(
      c.get('db'),
      c.get('tenantId'),
      c.get('edition'),
      sendContext(c),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 200)
  },
)

// POST, not GET: building the footer allocates the draft's inquiry token.
outreachRouter.post(
  '/outreach/drafts/:id/preview',
  zValidator('param', outreachLogIdParamSchema),
  async (c) => {
    const result = await previewDraft(
      c.get('db'),
      c.get('tenantId'),
      sendContext(c),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 200)
  },
)

outreachRouter.post(
  '/outreach/drafts/:id/mark-sent',
  zValidator('param', outreachLogIdParamSchema),
  async (c) => {
    const result = await markDraftSent(
      c.get('db'),
      c.get('tenantId'),
      c.get('edition'),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 200)
  },
)

outreachRouter.delete(
  '/outreach/drafts/:id',
  zValidator('param', outreachLogIdParamSchema),
  async (c) => {
    const result = await discardDraft(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

outreachRouter.post(
  '/outreach/drafts/discard',
  zValidator('json', discardDraftsBodySchema),
  async (c) => {
    const result = await discardDrafts(c.get('db'), c.get('tenantId'), c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

function sendContext(c: Context<{ Bindings: Env; Variables: Variables }>): SendContext {
  return {
    encryptionKey: c.env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    appUrl: c.env.APP_URL,
    apiUrl: new URL(c.req.url).origin,
    unsubscribeSecret: c.env.UNSUBSCRIBE_TOKEN_SECRET,
    e2eRecipientOverride: c.env.E2E_RECIPIENT_OVERRIDE ?? null,
    emailVerifyApiKey: c.env.REOON_API_KEY ?? null,
  }
}

