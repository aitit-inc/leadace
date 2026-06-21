import type { SendingIdentityProvider } from '../db/schema'

// Parsed once at the decryption boundary so callers consume a typed variant, not
// a bare string. For gmail_oauth the secret IS the OAuth refresh token.
export type SendingIdentitySecret = { provider: 'gmail_oauth'; refreshToken: string }

export function parseSendingIdentitySecret(
  provider: SendingIdentityProvider,
  decryptedSecret: string,
): SendingIdentitySecret {
  switch (provider) {
    case 'gmail_oauth':
      return { provider, refreshToken: decryptedSecret }
    case 'smtp_imap':
      throw new Error('smtp_imap sending identities are not supported yet')
  }
}
