import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { isUniqueViolation } from '../db/errors'
import { outreachLogs, prospects, responses, sendingIdentities } from '../db/schema'
import { asSendingIdentityId, asTenantId, type TenantId } from '../domain/ids'
import { hasReplyReadScope, parseSendingIdentitySecret } from '../domain/sending-identity'
import {
  attributeReply,
  sameDomainCandidates,
  toInboundReply,
  type Attribution,
  type CapturedReply,
  type InboundReply,
  type OutreachCandidate,
} from '../domain/reply'
import { detectDeterministicType, leadingUnquotedText, type DeterministicType } from '../domain/reply-classify'
import { getGmailAccessToken } from '../auth/google'
import { pollGmailInbox } from './gmail-poll'
import { pollImapInbox } from './imap-poll'
import { classifyReply, matchSameDomainReply, type ReplyClassification } from './reply-classify'
import { withLlmScope, type LlmEnv } from './llm'
import { recordResponse, type RecordResponseInput } from './responses'

type ReplyIngestEnv = LlmEnv & {
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

// A fixed lookback re-polled every run + dedup by source_message_id, NOT a
// last_polled_at cursor: provider SEARCH is only date-granular, so a cursor would
// drop a reply still unattributed or whose record failed once the UTC day rolled.
const POLL_LOOKBACK_DAYS = 7
const ATTRIBUTION_WINDOW_DAYS = 30
// Bounds the prompt when many recipients share one domain.
const MAX_SAME_DOMAIN_CANDIDATES = 5
const MAX_MESSAGES_PER_POLL = 50
const DAY_MS = 24 * 60 * 60 * 1000
// Cap stored content: a reply's meaningful text is short and top-posted, but a
// parsed body (quoted history, signatures, or a raw multipart fallback) can be
// huge. 4k matches the slice fed to the classifier.
const MAX_CONTENT_CHARS = 4_000

export type ReplyIngestSummary = {
  identitiesPolled: number
  identitiesSkipped: number
  pollErrors: number
  recorded: number
  deduped: number
  unattributed: number
  recordErrors: number
  // Per-poll snapshots like `unattributed`.
  sameDomainJudged: number
  sameDomainMatched: number
  identitiesAuthRevoked: number
}

type IdentityRow = {
  tenant_id: string
  identity_id: string
  provider: 'gmail_oauth' | 'smtp_imap'
  scope: string | null
  last_polled_at: string | null
}

// Clamp into record_response's accepted [now-7d, now] so a forged/skewed Date
// can't shift next_outreach_after; `now` is injected so this stays pure, and an
// invalid Date falls back to `now` rather than throwing.
export function clampReceivedAt(d: Date, now: number): string {
  const ms = d.getTime()
  const t = Number.isNaN(ms) ? now : Math.min(now, Math.max(now - 7 * DAY_MS, ms))
  return new Date(t).toISOString()
}

export function pollCapCutsSinceLastPoll(receivedAts: Date[], cap: number, lastPolledAt: Date): boolean {
  return receivedAts.length >= cap && receivedAts.every((d) => d > lastPolledAt)
}

export function recordFieldsForReply(
  responseType: ReplyClassification['responseType'] | DeterministicType,
  submittedAtIso: string,
  trusted: boolean,
): Pick<RecordResponseInput, 'responseType' | 'markDoNotContact' | 'rejectionFeedback'> {
  if (responseType === 'unsubscribe') {
    // Only a threaded reply (echoes our Message-ID, unforgeable) may ratchet
    // cross-project do_not_contact — same spoof gate as the bounce path.
    if (!trusted) return { responseType: 'rejection', markDoNotContact: false }
    return {
      responseType: 'rejection',
      markDoNotContact: true,
      rejectionFeedback: {
        version: 1,
        primary_reason: 'unsubscribe_request',
        submitted_at: submittedAtIso,
      },
    }
  }
  // No trust gate: micro tokens never directly set markDoNotContact; the
  // rejection-cycle DNC ratchet applies identically to untrusted LLM rejections.
  if (responseType === 'micro_later') {
    return {
      responseType: 'rejection',
      markDoNotContact: false,
      rejectionFeedback: {
        version: 1,
        primary_reason: 'wrong_timing',
        preferred_recontact_window: 'unspecified',
        submitted_at: submittedAtIso,
      },
    }
  }
  if (responseType === 'micro_not_me') {
    return {
      responseType: 'rejection',
      markDoNotContact: false,
      rejectionFeedback: {
        version: 1,
        primary_reason: 'not_decision_maker',
        submitted_at: submittedAtIso,
      },
    }
  }
  return { responseType, markDoNotContact: false }
}

async function loadCandidates(
  db: Db,
  tenantId: TenantId,
  identityId: string,
): Promise<OutreachCandidate[]> {
  const cutoff = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * DAY_MS)
  const rows = await db
    .select({
      outreachLogId: outreachLogs.id,
      prospectEmail: prospects.email,
      sentAt: outreachLogs.sentAt,
      messageId: outreachLogs.messageId,
    })
    .from(outreachLogs)
    .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
    .where(
      and(
        eq(outreachLogs.tenantId, tenantId),
        // Replies to a Send-As alias land in the parent's inbox, so the parent's
        // poll owns the alias's sends too.
        or(
          eq(outreachLogs.sendingIdentityId, identityId),
          inArray(
            outreachLogs.sendingIdentityId,
            db
              .select({ identityId: sendingIdentities.identityId })
              .from(sendingIdentities)
              .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.parentIdentityId, identityId))),
          ),
        ),
        eq(outreachLogs.channel, 'email'),
        eq(outreachLogs.status, 'sent'),
        gte(outreachLogs.sentAt, cutoff),
        isNotNull(prospects.email),
      ),
    )
  return rows.flatMap((r) =>
    r.prospectEmail
      ? [{ outreachLogId: r.outreachLogId, prospectEmail: r.prospectEmail, sentAt: r.sentAt, messageId: r.messageId }]
      : [],
  )
}

async function alreadyRecorded(
  db: Db,
  tenantId: TenantId,
  messageIds: string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set()
  const rows = await db
    .select({ id: responses.sourceMessageId })
    .from(responses)
    .where(and(eq(responses.tenantId, tenantId), inArray(responses.sourceMessageId, messageIds)))
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])))
}

// We mail info@ and a colleague answers from their own address: neither the
// thread nor the From matches.
async function matchBySameDomain(
  db: Db,
  env: ReplyIngestEnv,
  tenantId: TenantId,
  identityId: string,
  reply: InboundReply,
  candidates: OutreachCandidate[],
  now: Date,
  summary: ReplyIngestSummary,
): Promise<Attribution | null> {
  const pool = sameDomainCandidates(reply.fromEmail, candidates, ATTRIBUTION_WINDOW_DAYS, now, MAX_SAME_DOMAIN_CANDIDATES)
  if (pool.length === 0) return null
  summary.sameDomainJudged++

  const rows = await db
    .select({ outreachLogId: outreachLogs.id, subject: outreachLogs.subject, body: outreachLogs.body })
    .from(outreachLogs)
    .where(and(eq(outreachLogs.tenantId, tenantId), inArray(outreachLogs.id, pool.map((c) => c.outreachLogId))))
  const byId = new Map(rows.map((r) => [r.outreachLogId, r]))
  const sent = pool.flatMap((c) => {
    const row = byId.get(c.outreachLogId)
    return row ? [{ outreachLogId: c.outreachLogId, recipient: c.prospectEmail, sentAt: c.sentAt, subject: row.subject, body: row.body }] : []
  })

  const verdict = await withLlmScope({ tenantId }, () =>
    matchSameDomainReply(env, { fromEmail: reply.fromEmail, subject: reply.subject, bodyText: leadingUnquotedText(reply.bodyText) }, sent),
  )
  if (verdict === null) return null
  summary.sameDomainMatched++
  console.log(`[reply-ingest] same-domain match identity=${identityId} msg=${reply.messageId} outreach=${verdict.outreachLogId}: ${verdict.reason}`)
  return { outreachLogId: verdict.outreachLogId, binding: 'domain' }
}

type CaptureResult =
  | { ok: true; replies: CapturedReply[] }
  | { ok: false; detail: string; authRevoked: boolean }

async function capture(
  db: Db,
  tenantId: TenantId,
  identity: IdentityRow,
  env: ReplyIngestEnv,
  since: Date,
  secretText: string,
): Promise<CaptureResult> {
  const secret = parseSendingIdentitySecret(identity.provider, secretText)
  if (secret.provider === 'smtp_imap') {
    const polled = await pollImapInbox(
      { host: secret.imapHost, port: secret.imapPort, username: secret.username, appPassword: secret.appPassword },
      since,
      MAX_MESSAGES_PER_POLL,
    )
    return polled.ok ? polled : { ...polled, authRevoked: false }
  }
  const token = await getGmailAccessToken(db, {
    tenantId,
    credentialIdentityId: asSendingIdentityId(identity.identity_id),
    refreshToken: secret.refreshToken,
    encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  })
  if (!token.ok) {
    return token.rejection === 'revoked'
      ? { ok: false, detail: token.detail, authRevoked: true }
      : { ok: false, detail: `Blocked by the Google Workspace admin: ${token.detail}`, authRevoked: false }
  }
  const polled = await pollGmailInbox(token.accessToken, since, MAX_MESSAGES_PER_POLL)
  return polled.ok ? polled : { ...polled, authRevoked: false }
}

// A failure string can embed a full server response.
const MAX_POLL_ERROR_CHARS = 500

// COALESCE keeps the streak start.
async function markPollFailed(
  db: Db,
  tenantId: TenantId,
  identityId: string,
  detail: string,
): Promise<void> {
  await db
    .update(sendingIdentities)
    .set({
      pollFailingSince: sql`COALESCE(${sendingIdentities.pollFailingSince}, now())`,
      lastPollError: detail.slice(0, MAX_POLL_ERROR_CHARS),
    })
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
}

async function markPollSucceeded(db: Db, tenantId: TenantId, identityId: string): Promise<void> {
  await db
    .update(sendingIdentities)
    .set({ lastPolledAt: new Date(), pollFailingSince: null, lastPollError: null })
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
}

async function ingestIdentity(
  db: Db,
  env: ReplyIngestEnv,
  identity: IdentityRow,
  summary: ReplyIngestSummary,
): Promise<void> {
  const tenantId = asTenantId(identity.tenant_id)
  if (identity.provider === 'gmail_oauth' && !hasReplyReadScope(identity.scope)) {
    summary.identitiesSkipped++
    return
  }

  const since = new Date(Date.now() - POLL_LOOKBACK_DAYS * DAY_MS)

  // Decrypt per-identity (inside this scope, under the caller's per-identity
  // catch) so one undecryptable secret fails only this identity, not the run.
  const [secretRow] = await db.execute<{ secret: string | null }>(sql`
    SELECT pgp_sym_decrypt(secret, ${env.GMAIL_TOKEN_ENCRYPTION_KEY})::text AS secret
    FROM sending_identities
    WHERE tenant_id = ${identity.tenant_id} AND identity_id = ${identity.identity_id}
  `)
  if (!secretRow?.secret) {
    summary.pollErrors++
    await markPollFailed(db, tenantId, identity.identity_id, 'stored secret could not be decrypted')
    console.error(`[reply-ingest] secret unavailable identity=${identity.identity_id}`)
    return
  }

  const polled = await capture(db, tenantId, identity, env, since, secretRow.secret)
  if (!polled.ok) {
    summary.pollErrors++
    if (polled.authRevoked) summary.identitiesAuthRevoked++
    await markPollFailed(db, tenantId, identity.identity_id, polled.detail)
    console.error(`[reply-ingest] poll failed identity=${identity.identity_id} provider=${identity.provider} authRevoked=${polled.authRevoked}: ${polled.detail}`)
    return
  }
  summary.identitiesPolled++
  const lastPolledAt = identity.last_polled_at ? new Date(identity.last_polled_at) : null
  if (
    lastPolledAt &&
    pollCapCutsSinceLastPoll(polled.replies.map((r) => r.receivedAt), MAX_MESSAGES_PER_POLL, lastPolledAt)
  ) {
    console.warn(
      `[reply-ingest] ${MAX_MESSAGES_PER_POLL}-message cap cut into the window since the last poll (${lastPolledAt.toISOString()}) identity=${identity.identity_id}; messages in between were not fetched`,
    )
  }

  const inbound = polled.replies
    .map((c) => ({ captured: c, reply: toInboundReply(c) }))
    .flatMap((x) => (x.reply ? [{ captured: x.captured, reply: x.reply }] : []))
  if (inbound.length === 0) {
    await markPollSucceeded(db, tenantId, identity.identity_id)
    return
  }

  const seen = await alreadyRecorded(db, tenantId, inbound.map((x) => x.reply.messageId))
  const candidates = await loadCandidates(db, tenantId, identity.identity_id)
  const now = new Date()

  for (const { captured, reply } of inbound) {
    const det = detectDeterministicType(captured.email)
    const attribution = attributeReply(reply, candidates, ATTRIBUTION_WINDOW_DAYS, now)

    if (seen.has(reply.messageId)) {
      summary.deduped++
      continue
    }

    // A bounce forces DNC, so it records only when bound to a Message-ID we
    // generated; a sender-only match is forgeable and would hand anyone a
    // spoofed-DNC vector.
    if (det === 'bounce' && attribution?.binding !== 'threaded') {
      summary.unattributed++
      continue
    }
    // Only a person's own words are judged: a bounce, auto-reply or reply token
    // carries nothing that says which send it answers.
    const bound =
      attribution ??
      (det === null ? await matchBySameDomain(db, env, tenantId, identity.identity_id, reply, candidates, now, summary) : null)
    if (bound === null) {
      summary.unattributed++
      continue
    }
    const outreachLogId = bound.outreachLogId

    const classified = det
      ? { responseType: det, sentiment: 'neutral' as const }
      : (await withLlmScope({ tenantId }, () => classifyReply(env, { subject: reply.subject, bodyText: leadingUnquotedText(reply.bodyText) }))) ??
        { responseType: 'reply' as const, sentiment: 'neutral' as const }

    const rawContent = reply.bodyText.trim() || reply.subject || '(no text)'
    const content =
      rawContent.length > MAX_CONTENT_CHARS ? rawContent.slice(0, MAX_CONTENT_CHARS) + ' …[truncated]' : rawContent
    const receivedAtIso = clampReceivedAt(reply.receivedAt, now.getTime())
    const input: RecordResponseInput = {
      outreachLogId,
      channel: 'email',
      content,
      sentiment: classified.sentiment,
      ...recordFieldsForReply(classified.responseType, receivedAtIso, bound.binding === 'threaded'),
      receivedAt: receivedAtIso,
      sourceMessageId: reply.messageId,
    }

    try {
      // The cron runs outside the RLS request transaction, so each reply gets its
      // own (record_response does several writes); the unique index backstops a
      // concurrent re-poll.
      await db.transaction(async (tx) => {
        const result = await recordResponse(tx as unknown as Db, tenantId, input)
        if (!result.ok) throw new Error(`${result.code}: ${result.error}`)
      })
      summary.recorded++
      seen.add(reply.messageId)
    } catch (e) {
      if (isUniqueViolation(e)) {
        summary.deduped++
        seen.add(reply.messageId)
        continue
      }
      summary.recordErrors++
      console.error(`[reply-ingest] record failed identity=${identity.identity_id} msg=${reply.messageId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await markPollSucceeded(db, tenantId, identity.identity_id)
}

export async function runReplyIngest(db: Db, env: ReplyIngestEnv): Promise<ReplyIngestSummary> {
  const summary: ReplyIngestSummary = {
    identitiesPolled: 0,
    identitiesSkipped: 0,
    pollErrors: 0,
    recorded: 0,
    deduped: 0,
    unattributed: 0,
    recordErrors: 0,
    sameDomainJudged: 0,
    sameDomainMatched: 0,
    identitiesAuthRevoked: 0,
  }

  // A Send-As alias shares its parent's inbox, so only credential-holding rows
  // poll; a revoked grant cannot come back without a reconnect.
  const identities = await db.execute<IdentityRow>(sql`
    SELECT tenant_id, identity_id, provider, scope, last_polled_at
    FROM sending_identities
    WHERE parent_identity_id IS NULL
      AND auth_revoked_at IS NULL
  `)

  for (const identity of identities) {
    try {
      await ingestIdentity(db, env, identity, summary)
    } catch (e) {
      summary.pollErrors++
      const detail = e instanceof Error ? e.message : String(e)
      // Thrown paths (Google refresh 5xx) must feed the streak too; best-effort
      // so a DB failure here doesn't kill the remaining identities.
      try {
        await markPollFailed(db, asTenantId(identity.tenant_id), identity.identity_id, detail)
      } catch {}
      console.error(`[reply-ingest] identity ${identity.identity_id} threw: ${detail}`)
    }
  }

  return summary
}
