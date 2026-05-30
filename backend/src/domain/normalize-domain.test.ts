import { describe, it, expect } from 'vitest'
import { normalizeDomain } from './normalize-domain'

describe('normalizeDomain', () => {
  it('strips scheme, path, query and trailing junk down to the apex', () => {
    expect(normalizeDomain('https://www.Example.com/about?x=1')).toBe('example.com')
  })

  it('strips a port', () => {
    expect(normalizeDomain('http://example.com:8080/path')).toBe('example.com')
  })

  it('lowercases and trims', () => {
    expect(normalizeDomain('  EXAMPLE.COM  ')).toBe('example.com')
  })

  it('drops only a leading www., keeping other subdomains', () => {
    expect(normalizeDomain('www.example.com')).toBe('example.com')
    expect(normalizeDomain('app.example.com')).toBe('app.example.com')
  })

  it('is idempotent on an already-normalized domain', () => {
    expect(normalizeDomain('example.com')).toBe('example.com')
  })
})
