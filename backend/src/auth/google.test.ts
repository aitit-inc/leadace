import { describe, expect, it } from 'vitest'
import {
  buildComplianceAttachments,
  buildRfc822,
  plainTextToHtmlBody,
  formatFromHeader,
  applyE2eRedirect,
} from './google'
import { asTenantId } from '../domain/ids'

describe('buildComplianceAttachments', () => {
  const base = {
    prospectId: 1,
    tenantId: asTenantId('tenant-1'),
    appUrl: 'https://app.example',
    apiUrl: 'https://api.example',
    secret: 'test-secret',
    tenantLegalName: 'Acme Inc.',
    tenantPhysicalAddress: '1 Main St',
    tenantPrivacyPolicyUrl: null as string | null,
  }

  it('collapses to the inquiry link and drops the standalone Unsubscribe line when inquiry is enabled', async () => {
    const { footer, headers } = await buildComplianceAttachments({
      ...base,
      inquiryUrl: 'https://app.example/q/abc123',
    })
    expect(footer).toContain(
      'Learn more, ask anything, or unsubscribe: https://app.example/q/abc123',
    )
    expect(footer).not.toMatch(/^Unsubscribe: /m)
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('keeps the standalone Unsubscribe line when inquiry is disabled', async () => {
    const { footer, headers } = await buildComplianceAttachments({ ...base, inquiryUrl: null })
    expect(footer).toMatch(/^Unsubscribe: https:\/\/app\.example\/unsubscribe\//m)
    expect(footer).not.toContain('Learn more')
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('always emits the List-Unsubscribe header regardless of inquiry mode', async () => {
    const enabled = await buildComplianceAttachments({
      ...base,
      inquiryUrl: 'https://app.example/q/x',
    })
    const disabled = await buildComplianceAttachments({ ...base, inquiryUrl: null })
    expect(enabled.headers['List-Unsubscribe']).toBeDefined()
    expect(disabled.headers['List-Unsubscribe']).toBeDefined()
  })
})

describe('buildRfc822', () => {
  const base = { from: 'a@x.com', to: ['b@y.com'], subject: 'Hi', body: 'Hello' }

  it('strips CR/LF from inReplyTo so no header can be injected', () => {
    const rfc = buildRfc822({ ...base, inReplyTo: '<id@x>\r\nBcc: evil@z.com' })
    const lines = rfc.split('\r\n')
    expect(lines).not.toContain('Bcc: evil@z.com')
    expect(lines).toContain('In-Reply-To: <id@x>Bcc: evil@z.com')
    expect(lines).toContain('References: <id@x>Bcc: evil@z.com')
  })

  it('emits a multipart/alternative body with To/From/Subject headers', () => {
    const rfc = buildRfc822(base)
    expect(rfc).toContain('From: a@x.com')
    expect(rfc).toContain('To: b@y.com')
    expect(rfc).toContain('Content-Type: multipart/alternative; boundary="leadace-')
  })
})

describe('plainTextToHtmlBody', () => {
  it('escapes HTML metacharacters (no raw injection into the HTML part)', () => {
    const html = plainTextToHtmlBody('<b>a & "q" > c')
    expect(html).toContain('&lt;b&gt;a &amp; &quot;q&quot; &gt; c')
    expect(html).not.toContain('<b>a')
  })

  it('linkifies a URL and keeps trailing sentence punctuation out of the href', () => {
    const html = plainTextToHtmlBody('see https://example.com.')
    expect(html).toContain('<a href="https://example.com">https://example.com</a>.')
  })
})

describe('formatFromHeader', () => {
  it('returns the bare email when there is no display name', () => {
    expect(formatFromHeader('a@x.com', null)).toBe('a@x.com')
  })

  it('quotes an ASCII display name and escapes embedded quotes/backslashes', () => {
    expect(formatFromHeader('a@x.com', 'Alice')).toBe('"Alice" <a@x.com>')
    expect(formatFromHeader('a@x.com', 'Bob "the" Builder')).toBe('"Bob \\"the\\" Builder" <a@x.com>')
  })

  it('RFC2047 encoded-word for a non-ASCII display name (no quoted-string)', () => {
    const out = formatFromHeader('a@x.com', '山田太郎')
    expect(out).toMatch(/^=\?/)
    expect(out).toContain('?= <a@x.com>')
    expect(out).not.toContain('"山田太郎"')
  })
})

describe('applyE2eRedirect', () => {
  it('rewrites all recipients to the override and preserves originals in a header', () => {
    const envelope: {
      to: string[]
      cc?: string[]
      bcc?: string[]
      extraHeaders?: Record<string, string>
    } = { to: ['x@a.com'], cc: ['y@a.com'], bcc: ['z@a.com'] }
    const out = applyE2eRedirect(envelope, 'sink@test.com')
    expect(out.to).toEqual(['sink@test.com'])
    expect(out.cc).toBeUndefined()
    expect(out.bcc).toBeUndefined()
    expect(out.extraHeaders?.['X-E2E-Original-To']).toBe('x@a.com, y@a.com, z@a.com')
  })

  it('is a strict no-op for null / empty / whitespace overrides', () => {
    const env = { to: ['x@a.com'], cc: ['y@a.com'] }
    expect(applyE2eRedirect(env, null)).toBe(env)
    expect(applyE2eRedirect(env, '')).toBe(env)
    expect(applyE2eRedirect(env, '   ')).toBe(env)
    expect(applyE2eRedirect(env, undefined)).toBe(env)
  })
})
