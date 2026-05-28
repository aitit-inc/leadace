import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { recordBugReport, recordBugReportBodySchema } from '../../services/bug-reports'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const bugReportsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// POST /bug-reports — file a bug / feedback / idea. Daily-capped per
// tenant. Authenticated; the row is RLS-scoped to the caller's tenant.
bugReportsRouter.post(
  '/bug-reports',
  zValidator('json', recordBugReportBodySchema),
  async (c) => {
    const result = await recordBugReport(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)
