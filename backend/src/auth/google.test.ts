import { describe, expect, it } from 'vitest'
import {
  buildComplianceAttachments,
  buildRfc822,
  generateRfc822MessageId,
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
    locale: 'en' as const,
  }

  it('collapses to the inquiry link and drops the standalone unsubscribe line when inquiry is enabled', async () => {
    const { footer, headers } = await buildComplianceAttachments({
      ...base,
      inquiryUrl: 'https://app.example/q/abc123',
    })
    expect(footer).toContain('https://app.example/q/abc123')
    expect(footer).toMatch(/unsubscribe|opt out/i)
    expect(footer).not.toContain('/unsubscribe/')
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('is link-free with a reply-based opt-out when inquiry is disabled, header still present', async () => {
    const { footer, headers } = await buildComplianceAttachments({
      ...base,
      inquiryUrl: null,
    })
    expect(footer).toMatch(/unsubscribe|opt out/i)
    expect(footer).not.toMatch(/https?:\/\//) // no body link at all
    expect(headers['List-Unsubscribe']).toContain('https://api.example/api/unsubscribe/')
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('localizes the inquiry and unsubscribe lines for JP recipients', async () => {
    const inquiry = await buildComplianceAttachments({
      ...base,
      locale: 'ja',
      inquiryUrl: 'https://app.example/q/abc123',
    })
    expect(inquiry.footer).toContain('https://app.example/q/abc123')
    expect(inquiry.footer).toMatch(/停止/)
    expect(inquiry.footer).not.toMatch(/unsubscribe|opt out/i)
    expect(inquiry.footer).toContain('Acme Inc.')

    const linkFree = await buildComplianceAttachments({ ...base, locale: 'ja', inquiryUrl: null })
    expect(linkFree.footer).toMatch(/配信停止|返信/)
    expect(linkFree.footer).not.toMatch(/https?:\/\//)
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

  // The smtp_imap send handoff (sendForIdentity) relies on this contract: it omits
  // bcc from the args so the egressed message carries NO Bcc header — a raw SMTP
  // send transmits DATA verbatim and would otherwise disclose hidden recipients.
  // The Gmail arm passes bcc through, because the Gmail API uses the Bcc header as
  // its send envelope and strips it from delivered copies.
  it('emits a Bcc header only when bcc recipients are provided', () => {
    const withBcc = buildRfc822({ ...base, bcc: ['hidden@z.com'] }).split('\r\n')
    expect(withBcc).toContain('Bcc: hidden@z.com')

    const noBcc = buildRfc822(base).split('\r\n')
    expect(noBcc.some((l) => l.startsWith('Bcc:'))).toBe(false)
  })

  it('emits a Message-ID header only when provided, CR/LF-stripped', () => {
    const withId = buildRfc822({ ...base, messageId: '<tok@x.com>' }).split('\r\n')
    expect(withId).toContain('Message-ID: <tok@x.com>')

    const noId = buildRfc822(base).split('\r\n')
    expect(noId.some((l) => l.startsWith('Message-ID:'))).toBe(false)

    const injected = buildRfc822({ ...base, messageId: '<tok@x.com>\r\nBcc: evil@z.com' }).split('\r\n')
    expect(injected).not.toContain('Bcc: evil@z.com')
    expect(injected).toContain('Message-ID: <tok@x.com>Bcc: evil@z.com')
  })
})

describe('generateRfc822MessageId', () => {
  it('produces a bracketed <token@from-domain> id', () => {
    expect(generateRfc822MessageId('sales@surpassone.com')).toMatch(/^<[a-z0-9]{32}@surpassone\.com>$/)
  })

  it('falls back to a constant domain when From lacks one', () => {
    expect(generateRfc822MessageId('not-an-email')).toMatch(/^<[a-z0-9]{32}@leadace\.ai>$/)
  })

  it('is unguessably unique across calls', () => {
    expect(generateRfc822MessageId('a@x.com')).not.toBe(generateRfc822MessageId('a@x.com'))
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
