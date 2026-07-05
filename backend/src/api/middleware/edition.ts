import { createMiddleware } from 'hono/factory'
import { parseEdition } from '../../domain/edition'
import type { Env, Variables } from '../types'

// Mounted on all requests, including unauthenticated public ones — resolution is
// cheap and one uniform read path beats the saved nanoseconds.
export const editionMiddleware = createMiddleware<{
  Bindings: Env
  Variables: Variables
}>(async (c, next) => {
  c.set('edition', parseEdition(c.env.LEADACE_EDITION))
  await next()
})
