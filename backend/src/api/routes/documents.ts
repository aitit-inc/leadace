import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  documentParamSchema,
  documentHistoryQuerySchema,
  saveDocumentSchema,
  listDocuments,
  getDocument,
  getDocumentHistory,
  saveDocument,
} from '../../services/documents'
import { projectIdParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const documentsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

documentsRouter.get(
  '/projects/:id/documents',
  zValidator('param', projectIdParamSchema),
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
    const result = await getDocument(c.get('db'), c.get('tenantId'), c.req.valid('param'))
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
      c.req.valid('param'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)
