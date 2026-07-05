import { zValidator as honoZValidator } from '@hono/zod-validator'
import { z, type ZodType } from 'zod'

// The default @hono/zod-validator hook returns a raw ZodError, which the frontend's
// generic error handler renders as `[object Object]` — normalize to the project-wide
// `{ error, detail }` shape so validation and service failures look the same on the wire.
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
