import { Hono } from 'hono'
import { listAlerts } from '../../services/alerts'
import type { Env, Variables } from '../types'

export const alertsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

alertsRouter.get('/me/alerts', async (c) => {
  const alerts = await listAlerts(c.get('db'), c.get('tenantId'))
  return c.json({ alerts })
})
