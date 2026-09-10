import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedulesQuerySchema,
  createScheduleBodySchema,
  updateScheduleBodySchema,
  scheduleIdParamSchema,
} from '../../services/schedules'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const schedulesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

schedulesRouter.get('/schedules', zValidator('query', listSchedulesQuerySchema), async (c) => {
  const result = await listSchedules(c.get('db'), c.get('tenantId'), c.req.valid('query'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

schedulesRouter.post('/schedules', zValidator('json', createScheduleBodySchema), async (c) => {
  const result = await createSchedule(c.get('db'), c.get('tenantId'), c.get('userId'), c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

schedulesRouter.patch(
  '/schedules/:id',
  zValidator('param', scheduleIdParamSchema),
  zValidator('json', updateScheduleBodySchema),
  async (c) => {
    const result = await updateSchedule(c.get('db'), c.get('tenantId'), c.req.valid('param').id, c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

schedulesRouter.delete('/schedules/:id', zValidator('param', scheduleIdParamSchema), async (c) => {
  const result = await deleteSchedule(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
