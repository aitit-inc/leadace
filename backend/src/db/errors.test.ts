import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { isUniqueViolation, secretQuery } from './errors'

const pgError = (code: string) => Object.assign(new Error('pg'), { code })

describe('isUniqueViolation', () => {
  it('reads the SQLSTATE drizzle wraps in cause', () => {
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], pgError('23505')))).toBe(true)
  })

  it('rejects other SQLSTATEs', () => {
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], pgError('23503')))).toBe(false)
  })
})

describe('secretQuery', () => {
  it('drops the params of a failed query and keeps its cause', async () => {
    const failed = Promise.reject(new DrizzleQueryError('insert pgp_sym_encrypt($1, $2)', ['refresh-token-value', 'encryption-key-value'], pgError('23505')))
    const e = await secretQuery(failed).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DrizzleQueryError)
    expect(`${(e as Error).message} ${(e as Error).stack}`).not.toMatch(/refresh-token-value|encryption-key-value/)
    expect(isUniqueViolation(e)).toBe(true)
  })
})
