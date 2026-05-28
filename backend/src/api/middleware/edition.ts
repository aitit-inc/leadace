import { createMiddleware } from 'hono/factory'
import { parseEdition } from '../../domain/edition'
import type { Env, Variables } from '../types'

// Resolves the install edition once per request and stashes it in Variables
// so every downstream route / service reads it the same way. Mounted on all
// requests (including unauthenticated public ones like the inquiry chat or
// the Stripe webhook) — the resolution is cheap and the symmetry is worth
// more than the saved nanoseconds.
export const editionMiddleware = createMiddleware<{
  Bindings: Env
  Variables: Variables
}>(async (c, next) => {
  c.set('edition', parseEdition(c.env.LEADACE_EDITION))
  await next()
})
