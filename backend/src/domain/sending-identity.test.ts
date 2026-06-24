import { describe, it, expect } from 'vitest'
import { parseSendingIdentitySecret, senderAddressFor } from './sending-identity'

const validSmtp = JSON.stringify({
  smtpHost: 'smtp.zoho.com',
  smtpPort: 465,
  imapHost: 'imap.zoho.com',
  imapPort: 993,
  username: 'cold@example.com',
  appPassword: 'app-pw-123',
})

describe('parseSendingIdentitySecret', () => {
  it('parses a gmail_oauth secret as the refresh token', () => {
    expect(parseSendingIdentitySecret('gmail_oauth', 'refresh-token-abc')).toEqual({
      provider: 'gmail_oauth',
      refreshToken: 'refresh-token-abc',
    })
  })

  it('parses a valid smtp_imap JSON payload into the typed variant', () => {
    expect(parseSendingIdentitySecret('smtp_imap', validSmtp)).toEqual({
      provider: 'smtp_imap',
      smtpHost: 'smtp.zoho.com',
      smtpPort: 465,
      imapHost: 'imap.zoho.com',
      imapPort: 993,
      username: 'cold@example.com',
      appPassword: 'app-pw-123',
    })
  })

  it('throws on a malformed smtp_imap payload (missing fields)', () => {
    expect(() => parseSendingIdentitySecret('smtp_imap', '{}')).toThrow()
  })

  it('throws on a non-JSON smtp_imap secret', () => {
    expect(() => parseSendingIdentitySecret('smtp_imap', 'not-json')).toThrow()
  })

  it('rejects a non-465 smtpPort (465 implicit-TLS only)', () => {
    const port587 = JSON.stringify({ ...JSON.parse(validSmtp), smtpPort: 587 })
    expect(() => parseSendingIdentitySecret('smtp_imap', port587)).toThrow()
  })
})

describe('senderAddressFor', () => {
  it('gmail_oauth uses a verified Send-As alias when present', () => {
    expect(senderAddressFor('gmail_oauth', 'me@gmail.com', 'alias@brand.com')).toBe('alias@brand.com')
  })

  it('gmail_oauth falls back to the mailbox address when alias is blank/absent', () => {
    expect(senderAddressFor('gmail_oauth', 'me@gmail.com', '   ')).toBe('me@gmail.com')
    expect(senderAddressFor('gmail_oauth', 'me@gmail.com', null)).toBe('me@gmail.com')
    expect(senderAddressFor('gmail_oauth', 'me@gmail.com', undefined)).toBe('me@gmail.com')
  })

  // The crux: an SMTP mailbox can only send as its own address — a stale Gmail
  // alias must never leak into the SMTP envelope/From (would break SPF/DKIM).
  it('smtp_imap always uses the mailbox address, ignoring any alias', () => {
    expect(senderAddressFor('smtp_imap', 'cold@zoho-domain.com', 'alias@brand.com')).toBe('cold@zoho-domain.com')
    expect(senderAddressFor('smtp_imap', 'cold@zoho-domain.com', null)).toBe('cold@zoho-domain.com')
  })
})
