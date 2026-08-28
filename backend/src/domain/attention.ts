import type { SendingIdentityProvider } from '../db/schema'
import { hasReplyReadScope } from './sending-identity'

export type QuotaConstraint = 'daily' | 'lifetime' | 'monthly'

// The single "does anything need the user?" feed — every surface (bell,
// banners, dashboard) renders a view of this list, none judges on its own.
export type AttentionItem =
  | { kind: 'hot_leads'; count: number }
  | { kind: 'mcp_not_connected' }
  | { kind: 'compliance_incomplete'; missing: string[] }
  | { kind: 'gmail_disconnected' }
  | { kind: 'gmail_auth_revoked'; fromEmail: string; since: string }
  | { kind: 'no_outbound_channels' }
  | { kind: 'quota_exhausted'; constraint: QuotaConstraint }
  | { kind: 'reply_collection_scope_missing'; fromEmail: string }
  | { kind: 'reply_collection_failing'; fromEmail: string; since: string; detail: string | null }
  // The verdict is per project but the feed is tenant-wide, so the item
  // carries the project: name for the bell, id for the CTA's deep link.
  | { kind: 'outreach_futility'; projectId: string; projectName: string; sends: number; replies: number }
  | { kind: 'outreach_drafts'; count: number }

export type IdentityHealthInput = {
  fromEmail: string
  provider: SendingIdentityProvider
  scope: string | null
  authRevokedAt: Date | null
  pollFailingSince: Date | null
  lastPollError: string | null
}

// Transient outages self-heal within the 7-day re-poll window; only a
// persistent streak is worth a human's attention.
export const POLL_FAILING_ALERT_MS = 6 * 60 * 60 * 1000

export type IdentityAttentionItem = Extract<
  AttentionItem,
  { kind: 'gmail_auth_revoked' | 'reply_collection_scope_missing' | 'reply_collection_failing' }
>

// At most one item per identity — a dead credential explains a failing poll.
function identityProblem(
  identity: IdentityHealthInput,
  now: Date,
  failingAfterMs: number,
): IdentityAttentionItem | null {
  if (identity.authRevokedAt) {
    return {
      kind: 'gmail_auth_revoked',
      fromEmail: identity.fromEmail,
      since: identity.authRevokedAt.toISOString(),
    }
  }
  if (identity.provider === 'gmail_oauth' && !hasReplyReadScope(identity.scope)) {
    return { kind: 'reply_collection_scope_missing', fromEmail: identity.fromEmail }
  }
  if (identity.pollFailingSince && now.getTime() - identity.pollFailingSince.getTime() >= failingAfterMs) {
    return {
      kind: 'reply_collection_failing',
      fromEmail: identity.fromEmail,
      since: identity.pollFailingSince.toISOString(),
      detail: identity.lastPollError,
    }
  }
  return null
}

export function deriveIdentityAttention(
  identities: IdentityHealthInput[],
  now: Date,
): IdentityAttentionItem[] {
  return identities.flatMap((identity) => {
    const problem = identityProblem(identity, now, POLL_FAILING_ALERT_MS)
    return problem ? [problem] : []
  })
}

export type ReplyCollectionInput = IdentityHealthInput & { lastPolledAt: Date | null }

export type ReplyCollectionStatus =
  | { kind: 'none' }
  | { kind: 'collecting'; fromEmail: string; lastPolledAt: string | null }
  | IdentityAttentionItem

export function deriveReplyCollectionStatus(
  identity: ReplyCollectionInput | null,
  now: Date,
): ReplyCollectionStatus {
  if (identity === null) return { kind: 'none' }
  const problem = identityProblem(identity, now, 0)
  if (problem) return problem
  return {
    kind: 'collecting',
    fromEmail: identity.fromEmail,
    lastPolledAt: identity.lastPolledAt?.toISOString() ?? null,
  }
}

export type AttentionInput = {
  mcpConnected: boolean
  compliance: { ready: boolean; missing: string[] }
  gmailConnected: boolean
  identities: IdentityHealthInput[]
  quota: { exhausted: boolean; constraint: QuotaConstraint | null }
  futileProjects: Array<{ projectId: string; projectName: string; sends: number; replies: number }>
  now: Date
  // null = tenant-wide feed (bell, banners).
  project: {
    outboundChannelsConfigured: boolean
    pendingDrafts: number
    hotLeadsRecent: number
  } | null
}

// Push order is the display priority: opportunity → send blockers →
// degradation → review queue.
export function deriveAttentionItems(input: AttentionInput): AttentionItem[] {
  const identity = deriveIdentityAttention(input.identities, input.now)
  const revoked = identity.filter((i) => i.kind === 'gmail_auth_revoked')
  const degraded = identity.filter((i) => i.kind !== 'gmail_auth_revoked')

  const items: AttentionItem[] = []
  if (input.project && input.project.hotLeadsRecent > 0) {
    items.push({ kind: 'hot_leads', count: input.project.hotLeadsRecent })
  }
  if (!input.mcpConnected) items.push({ kind: 'mcp_not_connected' })
  if (!input.compliance.ready) {
    items.push({ kind: 'compliance_incomplete', missing: input.compliance.missing })
  }
  if (!input.gmailConnected) items.push({ kind: 'gmail_disconnected' })
  items.push(...revoked)
  if (input.project && !input.project.outboundChannelsConfigured) {
    items.push({ kind: 'no_outbound_channels' })
  }
  if (input.quota.exhausted && input.quota.constraint) {
    items.push({ kind: 'quota_exhausted', constraint: input.quota.constraint })
  }
  items.push(...degraded)
  for (const p of input.futileProjects) {
    items.push({
      kind: 'outreach_futility',
      projectId: p.projectId,
      projectName: p.projectName,
      sends: p.sends,
      replies: p.replies,
    })
  }
  if (input.project && input.project.pendingDrafts > 0) {
    items.push({ kind: 'outreach_drafts', count: input.project.pendingDrafts })
  }
  return items
}
