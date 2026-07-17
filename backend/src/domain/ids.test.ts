import { describe, it, expect } from 'vitest'
import {
  prospectIdSchema,
  prospectIdParamSchema,
  shortIdSchema,
  tenantIdSchema,
} from './ids'

describe('prospectIdSchema (strict, body/programmatic input)', () => {
  it('accepts a positive integer', () => {
    expect(prospectIdSchema.safeParse(5).success).toBe(true)
  })

  it('does NOT coerce — string/boolean numbers are rejected', () => {
    // z.coerce.number() would silently map all of these to 1/NaN.
    expect(prospectIdSchema.safeParse('5').success).toBe(false)
    expect(prospectIdSchema.safeParse(true).success).toBe(false)
    expect(prospectIdSchema.safeParse([[1]]).success).toBe(false)
  })

  it('rejects non-positive and non-integer values', () => {
    expect(prospectIdSchema.safeParse(0).success).toBe(false)
    expect(prospectIdSchema.safeParse(-1).success).toBe(false)
    expect(prospectIdSchema.safeParse(1.5).success).toBe(false)
  })
})

describe('prospectIdParamSchema (path/query, coerced)', () => {
  it('coerces the numeric path string', () => {
    expect(prospectIdParamSchema.parse({ id: '5' })).toEqual({ id: 5 })
  })

  it('rejects a non-numeric path segment', () => {
    expect(prospectIdParamSchema.safeParse({ id: 'abc' }).success).toBe(false)
  })
})

describe('shortIdSchema', () => {
  it('accepts a 22-char [A-Za-z0-9_-] token', () => {
    expect(shortIdSchema.safeParse('aB3_-xyzaB3_-xyzaB3_-x').success).toBe(true)
  })

  it('rejects tokens that are not exactly 22 valid chars', () => {
    expect(shortIdSchema.safeParse('aB3_-xyz').success).toBe(false)
    expect(shortIdSchema.safeParse('aB3_-xyzaB3_-xyzaB3_-xy').success).toBe(false)
    expect(shortIdSchema.safeParse('aB3_-xy!aB3_-xyzaB3_-x').success).toBe(false)
  })
})

describe('tenantIdSchema', () => {
  it('requires a non-empty string', () => {
    expect(tenantIdSchema.safeParse('tenant-1').success).toBe(true)
    expect(tenantIdSchema.safeParse('').success).toBe(false)
  })
})
