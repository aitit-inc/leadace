import { zValidator as honoZValidator } from '@hono/zod-validator'
import { z, type ZodType } from 'zod'

// Wraps @hono/zod-validator with a hook that normalizes failures into the
// project-wide `{ error, detail }` JSON shape. The default hook returns
// `{ success: false, error: ZodError, ... }`, which the frontend's generic
// error handler renders as `[object Object]`. Routes import from here so
// pre-route validation failures and post-route service failures look the
// same on the wire.
export function zValidator<T extends ZodType, Target extends 'json' | 'query' | 'param' | 'header' | 'cookie' | 'form'>(
  target: Target,
  schema: T,
) {
  return honoZValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'Invalid input',
          detail: z.flattenError(result.error),
        },
        400,
      )
    }
  })
}
