const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

// access_type=offline + prompt=consent make Google issue a refresh token, which
// the mailbox needs to mint access tokens long after this consent.
export function buildGoogleAuthorizationUrl(args: {
  clientId: string
  redirectUri: string
  scopes: string
  state: string
  loginHint: string | null
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', args.scopes)
  url.searchParams.set('state', args.state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  if (args.loginHint) url.searchParams.set('login_hint', args.loginHint)
  return url.toString()
}

// The id_token comes straight from Google's token endpoint over TLS, so its
// payload is read without signature verification. Null when the token carries
// no verified email.
export function parseIdTokenEmail(idToken: string): string | null {
  const payload = idToken.split('.')[1]
  if (!payload) return null
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null) return null
  const { email, email_verified: verified } = claims as { email?: unknown; email_verified?: unknown }
  if (typeof email !== 'string' || !email.includes('@')) return null
  if (verified !== true && verified !== 'true') return null
  return email
}
