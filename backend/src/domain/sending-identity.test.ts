import { describe, it, expect } from 'vitest'
import { parseSendingIdentitySecret } from './sending-identity'

const validSmtp = JSON.stringify({
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  imapHost: 'imap.gmail.com',
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
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      imapHost: 'imap.gmail.com',
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
