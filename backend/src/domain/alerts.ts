import type { SendingIdentityProvider } from '../db/schema'
import { hasReplyReadScope } from './sending-identity'

export type Alert =
  | { kind: 'reply_collection_revoked'; fromEmail: string; since: string }
  | { kind: 'reply_collection_scope_missing'; fromEmail: string }

export type IdentityAlertInput = {
  fromEmail: string
  provider: SendingIdentityProvider
  scope: string | null
  authRevokedAt: Date | null
}

export function deriveAlerts(identities: IdentityAlertInput[]): Alert[] {
  return identities.flatMap((identity): Alert[] => {
    if (identity.authRevokedAt) {
      return [
        {
          kind: 'reply_collection_revoked',
          fromEmail: identity.fromEmail,
          since: identity.authRevokedAt.toISOString(),
        },
      ]
    }
    if (identity.provider === 'gmail_oauth' && !hasReplyReadScope(identity.scope)) {
      return [{ kind: 'reply_collection_scope_missing', fromEmail: identity.fromEmail }]
    }
    return []
  })
}
