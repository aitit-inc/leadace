import { Hono } from 'hono'
import { createDb } from '../../db/connection'
import { logFunnel } from '../../services/funnel'
import { getCachedPublicScoreboard, liveQuerySchema } from '../../services/public-scoreboard'
import { err } from '../../services/result'
import { respondWithError } from '../respond'
import { zValidator } from '../zvalidator'
import type { Env, Variables } from '../types'
import type { ProjectId } from '../../domain/ids'

// Public, unauthenticated. There is no caller identity, so the project is
// pinned by SHOWCASE_PROJECT_ID and the service re-checks the project's own
// opt-in; createDb() bypasses RLS like the other public routers.
export const liveRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

liveRouter.get('/live', zValidator('query', liveQuerySchema), async (c) => {
  const projectId = c.env.SHOWCASE_PROJECT_ID as ProjectId | undefined
  if (!projectId) return respondWithError(c, err('NOT_FOUND', 'Scoreboard not available'))
  const db = createDb(c.env.DATABASE_URL)
  const result = await getCachedPublicScoreboard(db, projectId, c.get('edition'))
  if (!result.ok) return respondWithError(c, result)
  logFunnel({ event: 'live_viewed', projectId, ref: c.req.valid('query').ref ?? null })
  return c.json(result.value)
})
