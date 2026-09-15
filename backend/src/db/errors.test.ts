import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from './errors'

const pgError = (code: string) => Object.assign(new Error('pg'), { code })

describe('isUniqueViolation', () => {
  it('reads the SQLSTATE drizzle wraps in cause', () => {
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], pgError('23505')))).toBe(true)
  })

  it('rejects other SQLSTATEs', () => {
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], pgError('23503')))).toBe(false)
  })
})
