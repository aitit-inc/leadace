import { describe, expect, it } from 'vitest'
import { isoDateTimeSchema } from './time'

describe('isoDateTimeSchema', () => {
  it.each(['2026-10-24T12:30Z', '2026-10-24T12:30:00Z', '2026-10-24T12:30:00.123Z'])('accepts %s', (s) => {
    expect(isoDateTimeSchema.safeParse(s).success).toBe(true)
  })

  it.each(['2026-10-24', '2026-10-24T12Z', 'tomorrow'])('rejects %s', (s) => {
    expect(isoDateTimeSchema.safeParse(s).success).toBe(false)
  })
})
