import { describe, it, expect } from 'vitest'
import { isHttpsUrl, isHttpOrHttpsUrl, isPublicHttpsUrl } from './url'

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

describe('isPublicHttpsUrl', () => {
  it('accepts public https origins (with ports / paths)', () => {
    expect(isPublicHttpsUrl('https://app.leadace.ai')).toBe(true)
    expect(isPublicHttpsUrl('https://api.leadace.ai/api/unsubscribe/x')).toBe(true)
    expect(isPublicHttpsUrl('HTTPS://App.LeadAce.ai:8443')).toBe(true)
    expect(isPublicHttpsUrl('https://8.8.8.8')).toBe(true)
  })

  it('rejects non-https schemes', () => {
    expect(isPublicHttpsUrl('http://app.leadace.ai')).toBe(false)
    expect(isPublicHttpsUrl('http://localhost:5273/q/abc')).toBe(false)
    expect(isPublicHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isPublicHttpsUrl('not a url')).toBe(false)
  })

  it('rejects localhost and *.local even over https', () => {
    expect(isPublicHttpsUrl('https://localhost')).toBe(false)
    expect(isPublicHttpsUrl('https://localhost:8787')).toBe(false)
    expect(isPublicHttpsUrl('https://app.local')).toBe(false)
    expect(isPublicHttpsUrl('https://foo.localhost')).toBe(false)
  })

  it('rejects loopback / private / link-local IPs and IPv6 literals', () => {
    expect(isPublicHttpsUrl('https://127.0.0.1:5273')).toBe(false)
    expect(isPublicHttpsUrl('https://10.1.2.3')).toBe(false)
    expect(isPublicHttpsUrl('https://192.168.0.10')).toBe(false)
    expect(isPublicHttpsUrl('https://172.16.5.4')).toBe(false)
    expect(isPublicHttpsUrl('https://172.32.5.4')).toBe(true)
    expect(isPublicHttpsUrl('https://169.254.1.1')).toBe(false)
    expect(isPublicHttpsUrl('https://[::1]')).toBe(false)
  })

  it('rejects bare single-label hosts', () => {
    expect(isPublicHttpsUrl('https://intranet')).toBe(false)
  })
})
