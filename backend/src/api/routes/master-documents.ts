import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  listMasterDocuments,
  getMasterDocument,
  getMasterDocumentParamSchema,
} from '../../services/master-documents'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const masterDocumentsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

masterDocumentsRouter.get('/master-documents', async (c) => {
  const result = await listMasterDocuments(c.get('db'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

masterDocumentsRouter.get(
  '/master-documents/:slug',
  zValidator('param', getMasterDocumentParamSchema),
  async (c) => {
    const result = await getMasterDocument(c.get('db'), c.req.valid('param').slug)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
