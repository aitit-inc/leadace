import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { outreachLogs, prospects, responses, sendingIdentities } from '../db/schema'
import { asTenantId, type TenantId } from '../domain/ids'
import { parseSendingIdentitySecret } from '../domain/sending-identity'
import {
  attributeReply,
  bounceMatchesFinalRecipient,
  toInboundReply,
  type CapturedReply,
  type OutreachCandidate,
} from '../domain/reply'
import { detectDeterministicType, leadingUnquotedText, type DeterministicType } from '../domain/reply-classify'
import { refreshGoogleAccessToken } from '../auth/google'
import { pollGmailInbox } from './gmail-poll'
import { pollImapInbox } from './imap-poll'
import { classifyReply, type ReplyClassification } from './reply-classify'
import { recordResponse, type RecordResponseInput } from './responses'

type ReplyIngestEnv = {
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GEMINI_API_KEY: string
}

const GMAIL_READONLY_SCOPE = 'gmail.readonly'
// A fixed lookback re-polled every run + dedup by source_message_id, NOT a
// last_polled_at cursor: provider SEARCH is only date-granular, so a cursor would
// drop a reply still unattributed or whose record failed once the UTC day rolled.
const POLL_LOOKBACK_DAYS = 7
const ATTRIBUTION_WINDOW_DAYS = 30
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
  // Bounce attribution instrumentation (option A recall measurement). Both span
  // every bounce in the poll's lookback window — per-poll SNAPSHOTS, comparable to
  // each other within one run, not unique counts to sum across runs. threaded =
  // bound to our Message-ID (recorded + DNC); unthreaded = a DSN whose
  // Final-Recipient matched a real recent send but carried no Message-ID we
  // generated, so it is dropped (the recall A trades for spoof-safety).
  bouncesThreaded: number
  bouncesUnthreaded: number
}

type IdentityRow = {
  tenant_id: string
  identity_id: string
  provider: 'gmail_oauth' | 'smtp_imap'
  scope: string | null
}

// Clamp into record_response's accepted [now-7d, now] so a forged/skewed Date
// can't shift next_outreach_after; `now` is injected so this stays pure, and an
// invalid Date falls back to `now` rather than throwing.
export function clampReceivedAt(d: Date, now: number): string {
  const ms = d.getTime()
  const t = Number.isNaN(ms) ? now : Math.min(now, Math.max(now - 7 * DAY_MS, ms))
  return new Date(t).toISOString()
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

// 23505 (postgres unique_violation) on the responses insert means a concurrent
// re-poll already recorded this source_message_id — a benign dedup, not a failure.
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === '23505'
  )
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
        eq(outreachLogs.sendingIdentityId, identityId),
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

async function capture(
  identity: IdentityRow,
  env: ReplyIngestEnv,
  since: Date,
  secretText: string,
): Promise<{ ok: true; replies: CapturedReply[] } | { ok: false; detail: string }> {
  const secret = parseSendingIdentitySecret(identity.provider, secretText)
  if (secret.provider === 'smtp_imap') {
    return pollImapInbox(
      { host: secret.imapHost, port: secret.imapPort, username: secret.username, appPassword: secret.appPassword },
      since,
      MAX_MESSAGES_PER_POLL,
    )
  }
  const accessToken = await refreshGoogleAccessToken(
    secret.refreshToken,
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  )
  return pollGmailInbox(accessToken, since, MAX_MESSAGES_PER_POLL)
}

async function ingestIdentity(
  db: Db,
  env: ReplyIngestEnv,
  identity: IdentityRow,
  summary: ReplyIngestSummary,
): Promise<void> {
  const tenantId = asTenantId(identity.tenant_id)
  if (identity.provider === 'gmail_oauth' && !(identity.scope ?? '').includes(GMAIL_READONLY_SCOPE)) {
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
    console.error(`[reply-ingest] secret unavailable identity=${identity.identity_id}`)
    return
  }

  const polled = await capture(identity, env, since, secretRow.secret)
  if (!polled.ok) {
    summary.pollErrors++
    console.error(`[reply-ingest] poll failed identity=${identity.identity_id} provider=${identity.provider}: ${polled.detail}`)
    return
  }
  summary.identitiesPolled++
  if (polled.replies.length >= MAX_MESSAGES_PER_POLL) {
    console.warn(
      `[reply-ingest] poll hit ${MAX_MESSAGES_PER_POLL}-message cap identity=${identity.identity_id}; older replies beyond the newest ${MAX_MESSAGES_PER_POLL} may be missed`,
    )
  }

  const inbound = polled.replies
    .map((c) => ({ captured: c, reply: toInboundReply(c) }))
    .flatMap((x) => (x.reply ? [{ captured: x.captured, reply: x.reply }] : []))
  if (inbound.length === 0) {
    await db.update(sendingIdentities).set({ lastPolledAt: new Date() })
      .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identity.identity_id)))
    return
  }

  const seen = await alreadyRecorded(db, tenantId, inbound.map((x) => x.reply.messageId))
  const candidates = await loadCandidates(db, tenantId, identity.identity_id)
  // Attribute against the trusted poll time, not the sender-controlled Date header.
  const now = new Date()

  for (const { captured, reply } of inbound) {
    const det = detectDeterministicType(captured.email)
    const attribution = attributeReply(reply, candidates, ATTRIBUTION_WINDOW_DAYS, now)

    // Counted before the dedup short-circuit so both bounce counters span the
    // same population (semantics documented on ReplyIngestSummary).
    if (det === 'bounce') {
      if (attribution?.binding === 'threaded') {
        summary.bouncesThreaded++
      } else if (
        reply.dsn &&
        bounceMatchesFinalRecipient(reply.dsn.finalRecipients, candidates, ATTRIBUTION_WINDOW_DAYS, now)
      ) {
        summary.bouncesUnthreaded++
      }
    }

    if (seen.has(reply.messageId)) {
      summary.deduped++
      continue
    }

    // Trust gate: a bounce records (forces DNC) only when bound to a Message-ID we
    // generated. A bounce attributed only by sender / Final-Recipient is forgeable,
    // so it is dropped — closing the spoofed-DNC vector (option A).
    if (det === 'bounce' && attribution?.binding !== 'threaded') {
      summary.unattributed++
      continue
    }
    if (attribution === null) {
      summary.unattributed++
      continue
    }
    const outreachLogId = attribution.outreachLogId

    const classified = det
      ? { responseType: det, sentiment: 'neutral' as const }
      : (await classifyReply(env, { subject: reply.subject, bodyText: leadingUnquotedText(reply.bodyText) })) ??
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
      ...recordFieldsForReply(classified.responseType, receivedAtIso, attribution.binding === 'threaded'),
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

  await db.update(sendingIdentities).set({ lastPolledAt: new Date() })
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identity.identity_id)))
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
    bouncesThreaded: 0,
    bouncesUnthreaded: 0,
  }

  const identities = await db.execute<IdentityRow>(sql`
    SELECT tenant_id, identity_id, provider, scope
    FROM sending_identities
  `)

  for (const identity of identities) {
    try {
      await ingestIdentity(db, env, identity, summary)
    } catch (e) {
      summary.pollErrors++
      console.error(`[reply-ingest] identity ${identity.identity_id} threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return summary
}
