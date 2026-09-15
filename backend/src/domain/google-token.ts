import { z } from 'zod'

export type GoogleTokenRejection =
  // The refresh token is dead (user revoked access, six months unused, password
  // change, token limit, expiry); only re-consent fixes it.
  | 'revoked'
  // A Workspace admin restricted the app; the same token works again once the
  // admin lifts it.
  | 'blocked'
  // About our client or request, not the user's grant.
  | 'misconfigured'

const oauthErrorBodySchema = z.object({ error: z.string() })

export function classifyGoogleTokenRejection(body: string): GoogleTokenRejection {
  switch (oauthErrorCode(body)) {
    case 'invalid_grant':
      return 'revoked'
    case 'admin_policy_enforced':
      return 'blocked'
    default:
      return 'misconfigured'
  }
}

function oauthErrorCode(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const result = oauthErrorBodySchema.safeParse(parsed)
  return result.success ? result.data.error : null
}
