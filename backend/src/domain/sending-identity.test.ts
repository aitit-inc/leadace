import { describe, it, expect } from 'vitest'
import { parseSendingIdentitySecret } from './sending-identity'

describe('parseSendingIdentitySecret', () => {
  it('parses a gmail_oauth secret as the refresh token', () => {
    expect(parseSendingIdentitySecret('gmail_oauth', 'refresh-token-abc')).toEqual({
      provider: 'gmail_oauth',
      refreshToken: 'refresh-token-abc',
    })
  })

  it('throws for an unsupported provider (smtp_imap, P1)', () => {
    expect(() => parseSendingIdentitySecret('smtp_imap', '{}')).toThrow()
  })
})
