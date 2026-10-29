import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  addMeansBodySchema,
  applyFrameNow,
  applyProposalNow,
  listProposals,
  listProposalsQuerySchema,
  recordAddMeans,
  stopProposal,
} from '../../services/loop/proposals'
import { projectRefParamSchema } from '../../services/projects'
import { proposalIdParamSchema } from '../../domain/ids'
import { frameRequestSchema } from '../../domain/loop/proposal'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const proposalsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

proposalsRouter.get(
  '/projects/:id/proposals',
  zValidator('param', projectRefParamSchema),
  zValidator('query', listProposalsQuerySchema),
  async (c) => {
    const result = await listProposals(c.get('db'), c.get('tenantId'), c.req.valid('param').id, c.req.valid('query'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

proposalsRouter.post(
  '/projects/:id/proposals',
  zValidator('param', projectRefParamSchema),
  zValidator('json', addMeansBodySchema),
  async (c) => {
    const result = await recordAddMeans(c.get('db'), c.get('tenantId'), c.req.valid('param').id, c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, result.value.recorded ? 201 : 200)
  },
)

proposalsRouter.post(
  '/proposals/:id/apply',
  zValidator('param', proposalIdParamSchema),
  async (c) => {
    const result = await applyProposalNow(c.get('db'), c.get('tenantId'), c.get('caller'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

proposalsRouter.post(
  '/proposals/:id/stop',
  zValidator('param', proposalIdParamSchema),
  async (c) => {
    const result = await stopProposal(c.get('db'), c.get('tenantId'), c.get('caller'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

proposalsRouter.post(
  '/projects/:id/frame',
  zValidator('param', projectRefParamSchema),
  zValidator('json', frameRequestSchema),
  async (c) => {
    const result = await applyFrameNow(c.get('db'), c.get('tenantId'), c.get('origin'), c.req.valid('param').id, c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
