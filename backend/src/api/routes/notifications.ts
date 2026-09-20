import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { listNotifications, markNotificationsSeen, notify, notifyCtxOf, notifyUserSchema } from '../../services/notifications'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const notificationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

notificationsRouter.post('/notifications', zValidator('json', notifyUserSchema), async (c) => {
  // One request, one transaction: the reference is fresh per call, so there
  // is no rerun to guard against.
  const result = await notify(
    (fn) => fn(c.get('db')),
    c.get('tenantId'),
    notifyCtxOf(c.env),
    { ...c.req.valid('json'), reference: `notify_user:${crypto.randomUUID()}`, link: '/dashboard' },
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 200)
})

notificationsRouter.get('/me/notifications', async (c) => {
  const result = await listNotifications(c.get('db'), c.get('tenantId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json({ items: result.value })
})

notificationsRouter.post('/me/notifications/seen', async (c) => {
  const result = await markNotificationsSeen(c.get('db'), c.get('tenantId'))
  if (!result.ok) return respondWithError(c, result)
  return c.body(null, 204)
})
