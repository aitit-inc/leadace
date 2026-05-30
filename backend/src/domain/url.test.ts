import { describe, it, expect } from 'vitest'
import { isHttpsUrl, isHttpOrHttpsUrl } from './url'

describe('isHttpsUrl', () => {
  it('accepts https, case-insensitively', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true)
    expect(isHttpsUrl('HTTPS://example.com')).toBe(true)
  })

  it('rejects http and dangerous schemes', () => {
    expect(isHttpsUrl('http://example.com')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('data:text/html,<script>')).toBe(false)
  })
})

describe('isHttpOrHttpsUrl', () => {
  it('accepts http and https, case-insensitively', () => {
    expect(isHttpOrHttpsUrl('http://example.com')).toBe(true)
    expect(isHttpOrHttpsUrl('HTTPS://example.com')).toBe(true)
  })

  it('rejects dangerous and non-web schemes', () => {
    expect(isHttpOrHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpOrHttpsUrl('ftp://example.com')).toBe(false)
    expect(isHttpOrHttpsUrl('file:///etc/passwd')).toBe(false)
  })
})
