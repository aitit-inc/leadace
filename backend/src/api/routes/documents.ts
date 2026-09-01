import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  documentParamSchema,
  documentHistoryQuerySchema,
  saveDocumentSchema,
  approveDocumentSchema,
  listDocuments,
  getDocument,
  getDocumentHistory,
  saveDocument,
  approveDocumentVersion,
} from '../../services/documents'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const documentsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

documentsRouter.get(
  '/projects/:id/documents',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await listDocuments(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

documentsRouter.get(
  '/projects/:id/documents/:slug',
  zValidator('param', documentParamSchema),
  async (c) => {
    const result = await getDocument(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      c.req.valid('param'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

documentsRouter.get(
  '/projects/:id/documents/:slug/history',
  zValidator('param', documentParamSchema),
  zValidator('query', documentHistoryQuerySchema),
  async (c) => {
    const result = await getDocumentHistory(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      c.req.valid('param'),
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

documentsRouter.put(
  '/projects/:id/documents/:slug',
  zValidator('param', documentParamSchema),
  zValidator('json', saveDocumentSchema),
  async (c) => {
    const result = await saveDocument(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      { OPENAI_API_KEY: c.env.OPENAI_API_KEY },
      c.req.valid('param'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)

documentsRouter.post(
  '/projects/:id/documents/:slug/approve',
  zValidator('param', documentParamSchema),
  zValidator('json', approveDocumentSchema),
  async (c) => {
    const result = await approveDocumentVersion(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      c.req.valid('param'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
