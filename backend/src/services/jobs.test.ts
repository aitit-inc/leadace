import { describe, expect, it } from 'vitest'
import { dailyCycleIdempotencyKey } from './jobs'
import { utcDateKey } from '../domain/time'
import { asProjectId } from '../domain/ids'

describe('daily cycle idempotency key', () => {
  it('is one key per project per UTC day', () => {
    const p = asProjectId('P1')
    expect(dailyCycleIdempotencyKey(p, new Date('2026-09-05T23:59:59Z'))).toBe('P1:2026-09-05')
    expect(dailyCycleIdempotencyKey(p, new Date('2026-09-06T00:00:00Z'))).toBe('P1:2026-09-06')
    expect(utcDateKey(new Date('2026-09-05T15:00:00+09:00'))).toBe('2026-09-05')
  })
})
