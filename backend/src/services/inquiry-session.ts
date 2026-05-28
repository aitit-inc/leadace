import { z } from 'zod'
import { eq, and, isNull, isNotNull, asc, desc, inArray, sql } from 'drizzle-orm'
import {
  inquirySessions,
  inquiryMessages,
  inquiryTokens,
  prospects,
  projects,
  projectProspects,
  projectSettings,
  outreachLogs,
  organizations,
  orgSignalsGlobal,
  REJECTION_PRIMARY_REASONS,
  type Channel,
  type InquiryCtaType,
  type InquiryOutcome,
  type InquiryMessageRole,
  type InquirySessionContextSnapshot,
  type MeetingRequestSource,
  type OrgSignals,
  type ProspectHypothesis,
  type RejectionFeedbackV1,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  asShortId,
  asTenantId,
  projectIdSchema,
  type ProjectId,
  type ShortId,
  type TenantId,
} from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import type { InquiryTokenRow } from './inquiry-token'
import { requireProject } from './projects'
import { recordResponse } from './responses'
import { isHttpsUrl } from '../domain/url'
import { rejectionConsentSchema } from '../domain/rejection-feedback'
import { extractFaqQuestions } from '../domain/faq-suggestions'

// Sentinel for concurrent-close detection inside db.transaction blocks —
// drizzle rethrows whatever's thrown after rollback, so a typed class is
// the simplest correlation back to a CONFLICT result.
export class SessionRaceError extends Error {
  constructor() {
    super('inquiry session closed by concurrent request')
  }
}

// Subset of RejectionFeedbackV1: the landing chip only collects
// primary_reason + free_text + consent. Other fields belong to email-reply
// flows where the recipient types freely.
export const inquiryUnsubscribeBodySchema = z.object({
  primary_reason: z.enum(REJECTION_PRIMARY_REASONS).optional(),
  free_text: z.string().max(500).optional(),
  consent: rejectionConsentSchema.optional(),
})
export type InquiryUnsubscribeInput = z.infer<typeof inquiryUnsubscribeBodySchema>

export const inquiryChatMessageBodySchema = z.object({
  message: z.string().min(1).max(2000),
})
export type InquiryChatMessageInput = z.infer<typeof inquiryChatMessageBodySchema>

export const inquiryRequestMeetingBodySchema = z
  .object({
    note: z.string().max(500).optional(),
  })
  .strict()
export type InquiryRequestMeetingInput = z.infer<typeof inquiryRequestMeetingBodySchema>

export type InquirySessionRow = {
  id: number
  tenantId: TenantId
  prospectId: number
  outreachLogId: number
  shortId: ShortId
  responseId: number | null
  outcome: InquiryOutcome
  meetingRequestSource: MeetingRequestSource | null
  derivedSummary: string | null
  chatTurnsUsed: number
  contextSnapshot: InquirySessionContextSnapshot | null
  openedAt: Date
  closedAt: Date | null
}

// Signals are considered "fresh" when refreshed within this many days. Stale
// signals are dropped from the snapshot to avoid feeding the chat LLM
// outdated talking points.
const SIGNAL_FRESH_DAYS_FOR_SNAPSHOT = 30

// Compose the per-session brief used as the chat system prompt. Falls back
// gracefully when hypothesis / signals are missing — at minimum the project's
// inquiry_chat_brief and the visiting organization's name make it through.
function composeContextSnapshot(args: {
  projectInquiryChatBrief: string
  contactName: string | null
  hypothesis: ProspectHypothesis | null
  organizationName: string
  organizationDomain: string
  prospectOverview: string
  prospectIndustry: string | null
  prospectCountry: string | null
  signals: OrgSignals | null
  signalsUpdatedAt: Date | null
}): InquirySessionContextSnapshot {
  const lines: string[] = []
  lines.push('[Service description]')
  lines.push(args.projectInquiryChatBrief.trim())
  lines.push('')
  lines.push('[Visiting organization]')
  const orgHeader = `${args.organizationName} (${args.organizationDomain})`
  const meta = [args.prospectIndustry, args.prospectCountry].filter((v): v is string => !!v).join(' / ')
  lines.push(meta ? `${orgHeader} — ${meta}` : orgHeader)
  // overview is build-list's per-prospect company summary (and may include a
  // trailing `## Recent Signals` section when build-list Phase 1.7 surfaced
  // anything). Drop it in verbatim so the chat LLM has the same factual base
  // outbound used to compose the email.
  const overview = args.prospectOverview.trim()
  if (overview.length > 0) {
    lines.push('')
    lines.push('About:')
    lines.push(overview)
  }

  const h = args.hypothesis
  const hasHypothesisFacts =
    !!h &&
    ((h.hypothesizedPain?.length ?? 0) > 0 ||
      (h.valueMapping?.length ?? 0) > 0 ||
      (h.timingSignals?.length ?? 0) > 0)
  if (h && hasHypothesisFacts) {
    lines.push('')
    lines.push('[Hypothesised fit]')
    if (h.hypothesizedPain?.length) {
      lines.push(`- Pain points: ${h.hypothesizedPain.join(', ')}`)
    }
    if (h.valueMapping?.length) {
      lines.push(`- Value mapping: ${h.valueMapping.join(', ')}`)
    }
    if (h.timingSignals?.length) {
      lines.push(`- Timing signals: ${h.timingSignals.join(', ')}`)
    }
  }

  const fresh =
    args.signalsUpdatedAt !== null &&
    Date.now() - args.signalsUpdatedAt.getTime() <
      SIGNAL_FRESH_DAYS_FOR_SNAPSHOT * 24 * 60 * 60 * 1000
  if (fresh && args.signals?.highlights && args.signals.highlights.length > 0) {
    lines.push('')
    lines.push('[Recent signals]')
    for (const s of args.signals.highlights.slice(0, 5)) {
      lines.push(`- ${s}`)
    }
  }

  return {
    brief: lines.join('\n'),
    prospectHints: {
      contactName: args.contactName ?? undefined,
      organizationName: args.organizationName,
      hypothesizedPain: h?.hypothesizedPain,
      timingSignals: h?.timingSignals,
    },
    sourceUpdatedAt: new Date().toISOString(),
  }
}

// One-time write per session: the conditional UPDATE only lands the snapshot
// when it's still NULL, so concurrent first-message paths can't double-write.
// Returns the freshly snapshotted session so callers can use it without an
// extra round-trip.
export async function ensureSessionContextSnapshot(
  db: Db,
  session: InquirySessionRow,
  projectInquiryChatBrief: string | null,
): Promise<InquirySessionRow> {
  if (session.contextSnapshot) return session
  if (!projectInquiryChatBrief || projectInquiryChatBrief.trim().length === 0) {
    return session
  }

  const [row] = await db
    .select({
      contactName: prospects.contactName,
      hypothesis: prospects.hypothesis,
      organizationName: organizations.name,
      organizationDomain: organizations.domain,
      prospectOverview: prospects.overview,
      prospectIndustry: prospects.industry,
      prospectCountry: prospects.country,
      signals: orgSignalsGlobal.signals,
      signalsUpdatedAt: orgSignalsGlobal.signalsUpdatedAt,
    })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(eq(prospects.id, session.prospectId))
    .limit(1)

  if (!row) return session

  const snapshot = composeContextSnapshot({
    projectInquiryChatBrief,
    contactName: row.contactName,
    hypothesis: row.hypothesis,
    organizationName: row.organizationName,
    organizationDomain: row.organizationDomain,
    prospectOverview: row.prospectOverview,
    prospectIndustry: row.prospectIndustry,
    prospectCountry: row.prospectCountry,
    signals: row.signals,
    signalsUpdatedAt: row.signalsUpdatedAt,
  })

  const [updated] = await db
    .update(inquirySessions)
    .set({ contextSnapshot: snapshot })
    .where(and(eq(inquirySessions.id, session.id), isNull(inquirySessions.contextSnapshot)))
    .returning()

  return updated ? brandSessionRow(updated) : session
}

const brandSessionRow = <T extends { tenantId: string; shortId: string }>(
  row: T,
): Omit<T, 'tenantId' | 'shortId'> & { tenantId: TenantId; shortId: ShortId } => ({
  ...row,
  tenantId: asTenantId(row.tenantId),
  shortId: asShortId(row.shortId),
})

// A re-visit after a closing outcome opens a NEW session rather than
// reviving the closed one — funnel analytics treat each visit as distinct.
// The partial unique index `idx_inquiry_session_open` collapses concurrent
// first-visits to a single row; the re-select after onConflictDoNothing
// recovers the row the loser of the race didn't insert.
export async function openLandingSession(
  db: Db,
  token: InquiryTokenRow,
): Promise<InquirySessionRow> {
  const existing = await selectOpenSession(db, token.shortId)
  if (existing) return existing

  const [created] = await db
    .insert(inquirySessions)
    .values({
      tenantId: token.tenantId,
      prospectId: token.prospectId,
      outreachLogId: token.outreachLogId,
      shortId: token.shortId,
      outcome: 'opened',
    })
    .onConflictDoNothing({
      target: inquirySessions.shortId,
      where: isNull(inquirySessions.closedAt),
    })
    .returning()

  if (created) return brandSessionRow(created)

  const racey = await selectOpenSession(db, token.shortId)
  if (!racey) throw new Error('Failed to obtain inquiry session after conflict')
  return racey
}

async function selectOpenSession(
  db: Db,
  shortId: ShortId,
): Promise<InquirySessionRow | undefined> {
  const [row] = await db
    .select()
    .from(inquirySessions)
    .where(and(eq(inquirySessions.shortId, shortId), isNull(inquirySessions.closedAt)))
    .limit(1)
  return row ? brandSessionRow(row) : undefined
}

export async function requireOpenSession(
  db: Db,
  shortId: ShortId,
): Promise<ServiceResult<InquirySessionRow>> {
  const row = await selectOpenSession(db, shortId)
  if (!row) return err('NOT_FOUND', 'Inquiry session is no longer open')
  return ok(row)
}

export async function appendInquiryMessage(
  db: Db,
  sessionId: number,
  tenantId: TenantId,
  role: InquiryMessageRole,
  content: string,
): Promise<void> {
  await db.insert(inquiryMessages).values({
    tenantId,
    sessionId,
    role,
    content,
  })
}

// Flip opened → inquired on the first user message. Conditional WHERE so a
// concurrent request-meeting / unsubscribe close wins; the same WHERE also
// makes the call a no-op when outcome has already advanced past 'opened'.
export async function markSessionInquired(
  db: Db,
  sessionId: number,
): Promise<void> {
  await db
    .update(inquirySessions)
    .set({ outcome: 'inquired' })
    .where(and(
      eq(inquirySessions.id, sessionId),
      eq(inquirySessions.outcome, 'opened'),
      isNull(inquirySessions.closedAt),
    ))
}

// Atomic reservation in a single round trip: only increments when the session
// is still open AND under the per-session cap. Throws SessionRaceError on any
// other case (concurrent close via unsubscribe / request-meeting, or a
// concurrent chat turn just hit the cap), so the surrounding tx rolls back
// cleanly. Caller maps SessionRaceError → CONFLICT.
export async function reserveChatTurnSlot(
  db: Db,
  sessionId: number,
): Promise<number> {
  const [row] = await db
    .update(inquirySessions)
    .set({ chatTurnsUsed: sql`${inquirySessions.chatTurnsUsed} + 1` })
    .where(and(
      eq(inquirySessions.id, sessionId),
      isNull(inquirySessions.closedAt),
      sql`${inquirySessions.chatTurnsUsed} < ${INQUIRY_CHAT_TURNS_MAX}`,
    ))
    .returning({ chatTurnsUsed: inquirySessions.chatTurnsUsed })
  if (!row) throw new SessionRaceError()
  return row.chatTurnsUsed
}

export type InquiryTranscriptEntry = {
  role: InquiryMessageRole
  content: string
  createdAt: Date
}

export async function loadInquiryTranscript(
  db: Db,
  sessionId: number,
): Promise<InquiryTranscriptEntry[]> {
  return db
    .select({
      role: inquiryMessages.role,
      content: inquiryMessages.content,
      createdAt: inquiryMessages.createdAt,
    })
    .from(inquiryMessages)
    .where(eq(inquiryMessages.sessionId, sessionId))
    // id tiebreaker: user/assistant messages inserted in the same tx can
    // share defaultNow(), so ordering by created_at alone is unstable.
    .orderBy(asc(inquiryMessages.createdAt), asc(inquiryMessages.id))
}

// Filler for `responses.content` (NOT NULL) when no recipient note / AI
// summary is available. `inquiry_sessions.derived_summary` stays null in
// that case — design doc §5.1 reserves it for real text only.
const MEETING_REQUEST_PLACEHOLDER: Record<MeetingRequestSource, string> = {
  button: '(meeting requested via inquiry button)',
  chat: '(meeting requested via inquiry chat)',
}

// Pre-resolved session info needed to commit a meeting-request inside the
// race-safe transaction. Both recordMeetingRequest (loads from shortId) and
// inquiry-summarize.ts (loads alongside the LLM step) feed the same shape
// through here so the SessionRaceError handling lives in one place.
export type MeetingRequestTarget = {
  sessionId: number
  tenantId: TenantId
  outreachLogId: number
  channel: Channel
}

export async function recordMeetingRequestForSession(
  db: Db,
  target: MeetingRequestTarget,
  source: MeetingRequestSource,
  summary: string | null,
): Promise<ServiceResult<{ responseId: number }>> {
  const now = new Date()
  const trimmed = summary?.trim() ?? ''
  const derivedSummary = trimmed.length > 0 ? trimmed : null

  try {
    // db.transaction here is legitimate: this service is only called from the
    // public token-authenticated inquiry routes, which use createDb() directly
    // and bypass the RLS middleware (see CLAUDE.md "Multi-Tenancy"). The `db`
    // received here is therefore a raw connection, not a tx already opened by
    // rls.ts — opening one here does not nest, so postgres-js's SAVEPOINT
    // semantics don't apply.
    return await db.transaction(async (tx) => {
      // PgTransaction → Db cast matches the rls.ts pattern; recordResponse
      // wants the wider `PostgresJsDatabase & { $client }` type.
      const result = await recordResponse(tx as unknown as Db, target.tenantId, {
        outreachLogId: target.outreachLogId,
        channel: target.channel,
        content: derivedSummary ?? MEETING_REQUEST_PLACEHOLDER[source],
        sentiment: 'positive',
        responseType: 'meeting_request',
        receivedAt: now.toISOString(),
        markDoNotContact: false,
      })
      if (!result.ok) return result
      const responseId = result.value.id
      if (responseId === undefined) {
        throw new Error('Failed to insert meeting_request response')
      }

      const [updated] = await tx
        .update(inquirySessions)
        .set({
          outcome: 'lead',
          meetingRequestSource: source,
          responseId,
          derivedSummary,
          closedAt: now,
        })
        .where(and(eq(inquirySessions.id, target.sessionId), isNull(inquirySessions.closedAt)))
        .returning({ id: inquirySessions.id })

      if (!updated) throw new SessionRaceError()

      return ok({ responseId: responseId })
    })
  } catch (e) {
    if (e instanceof SessionRaceError) {
      return err('CONFLICT', 'Inquiry session is no longer open')
    }
    throw e
  }
}

// Records that the visitor clicked the Sign up CTA. Closes the session
// with outcome='signup_clicked' so daily-cycle / evaluate can aggregate
// self-serve conversions separately from human-sales 'lead' conversions.
// No responses row is written — signup is the explicit non-meeting path,
// so the response-typed reporting axes (sentiment, response_type) don't
// apply. Idempotent on repeat clicks: a session already closed as
// 'signup_clicked' returns ok so a double-click doesn't surface as an
// error in the UI.
//
// Also flips project_prospects.status to 'responded' (same terminal state
// the meeting_request flow uses via nextStatusFromResponse) so the prospect
// drops out of REACHABLE_STATUSES and won't be re-targeted by
// get_outbound_targets after the no-response recycle window elapses.
// Without this, a converted prospect would re-enter the outbound pool
// ~90 days later and receive an unwanted follow-up — the
// inquiry_sessions.outcome alone never feeds the outbound selector.
//
// Server-side gates the action by project_settings.inquiry_cta_type to
// prevent direct POSTs from recording signup_clicked against a project
// that is configured for the meeting CTA — the URL token is the only
// auth, so a stale or hand-crafted client must not be able to skew
// outcome aggregates.
export async function recordSignupClick(
  db: Db,
  shortId: ShortId,
): Promise<ServiceResult<{ sessionId: number }>> {
  // Idempotent: any prior closed signup_clicked row for this short_id is the
  // recorded conversion regardless of whether the recipient has since opened
  // a new session by revisiting. Without this, the second click would
  // re-record (closing the new open session as signup_clicked) and the
  // table would carry two signup_clicked rows for the same short_id —
  // skewing per-prospect conversion counts.
  const prior = await selectClosedSignupClick(db, shortId)
  if (prior) return ok({ sessionId: prior.id })

  const session = await requireOpenSession(db, shortId)
  if (!session.ok) return session
  const s = session.value

  const ctaType = await readInquiryCtaType(db, s.outreachLogId)
  if (ctaType !== 'signup') {
    return err('CONFLICT', "Project CTA is not configured for 'signup'")
  }

  const now = new Date()
  try {
    // See recordMeetingRequestForSession for why db.transaction here is OK.
    return await db.transaction(async (tx) => {
      const [log] = await tx
        .select({ projectId: outreachLogs.projectId })
        .from(outreachLogs)
        .where(eq(outreachLogs.id, s.outreachLogId))
        .limit(1)
      if (!log) return err('NOT_FOUND', 'Outreach log not found')

      const [updated] = await tx
        .update(inquirySessions)
        .set({ outcome: 'signup_clicked', closedAt: now })
        .where(and(eq(inquirySessions.id, s.id), isNull(inquirySessions.closedAt)))
        .returning({ id: inquirySessions.id })

      if (!updated) throw new SessionRaceError()

      await tx
        .update(projectProspects)
        .set({ status: 'responded', updatedAt: now })
        .where(
          and(
            eq(projectProspects.projectId, log.projectId),
            eq(projectProspects.prospectId, s.prospectId),
          ),
        )

      return ok({ sessionId: updated.id })
    })
  } catch (e) {
    if (e instanceof SessionRaceError) {
      return err('CONFLICT', 'Inquiry session is no longer open')
    }
    throw e
  }
}

// CTA mode for the project that owns this outreach. left-join project_settings
// so legacy projects without a settings row default to 'meeting' (the column
// default), matching the loadLandingContext fallback.
async function readInquiryCtaType(
  db: Db,
  outreachLogId: number,
): Promise<InquiryCtaType> {
  const [row] = await db
    .select({ inquiryCtaType: projectSettings.inquiryCtaType })
    .from(outreachLogs)
    .leftJoin(projectSettings, eq(projectSettings.projectId, outreachLogs.projectId))
    .where(eq(outreachLogs.id, outreachLogId))
    .limit(1)
  return row?.inquiryCtaType ?? 'meeting'
}

// Button-source meeting requests come from /inquiry/:shortId/request-meeting
// only — chat-derived escalations call recordMeetingRequestForSession
// directly from inquiry-summarize.ts. Source-'button' means the visitor
// tapped the meeting CTA; that CTA is only rendered when the project is
// in 'meeting' mode, so a button POST against a 'signup'-mode project is
// either a stale client or a hand-crafted request — reject so outcome
// aggregates can't be skewed by direct POSTs to the public route.
export async function recordMeetingRequest(
  db: Db,
  shortId: ShortId,
  source: MeetingRequestSource,
  summary: string | null,
): Promise<ServiceResult<{ responseId: number }>> {
  // Idempotent re-click: a session already closed as 'lead' with a linked
  // response returns ok so a double-tap (or a re-visit after the close)
  // doesn't surface as 409 in the UI. Mirrors recordSignupClick's
  // signup_clicked short-circuit.
  const existing = await selectRelevantSession(db, shortId)
  if (
    existing &&
    existing.closedAt !== null &&
    existing.outcome === 'lead' &&
    existing.responseId !== null
  ) {
    return ok({ responseId: existing.responseId })
  }

  const session = await requireOpenSession(db, shortId)
  if (!session.ok) return session
  const s = session.value

  const [log] = await db
    .select({ channel: outreachLogs.channel })
    .from(outreachLogs)
    .where(eq(outreachLogs.id, s.outreachLogId))
    .limit(1)
  if (!log) return err('NOT_FOUND', 'Outreach log not found')

  if (source === 'button') {
    const ctaType = await readInquiryCtaType(db, s.outreachLogId)
    if (ctaType !== 'meeting') {
      return err('CONFLICT', "Project CTA is not configured for 'meeting'")
    }
  }

  return recordMeetingRequestForSession(
    db,
    {
      sessionId: s.id,
      tenantId: s.tenantId,
      outreachLogId: s.outreachLogId,
      channel: log.channel,
    },
    source,
    summary,
  )
}

// Multiple sessions can share a shortId — only one *open* row at a time
// (partial unique index `idx_inquiry_session_open`), but closed rows
// accumulate as `openLandingSession` opens a new session on every revisit
// after a prior close. For unsubscribe, prefer the open row so a recipient
// who chatted (closed 'inquired') and revisits can still opt out; fall back
// to the most recent closed row to keep the idempotent already-unsubscribed
// path working.
async function selectRelevantSession(
  db: Db,
  shortId: ShortId,
): Promise<InquirySessionRow | undefined> {
  const [row] = await db
    .select()
    .from(inquirySessions)
    .where(eq(inquirySessions.shortId, shortId))
    .orderBy(
      sql`${inquirySessions.closedAt} IS NULL DESC`,
      desc(inquirySessions.openedAt),
    )
    .limit(1)
  return row ? brandSessionRow(row) : undefined
}

// Look up the most recent closed-as-signup_clicked session for this short_id,
// ignoring any concurrently open session opened on revisit. Used by
// recordSignupClick's idempotent shortcut.
async function selectClosedSignupClick(
  db: Db,
  shortId: ShortId,
): Promise<InquirySessionRow | undefined> {
  const [row] = await db
    .select()
    .from(inquirySessions)
    .where(and(
      eq(inquirySessions.shortId, shortId),
      eq(inquirySessions.outcome, 'signup_clicked'),
      isNotNull(inquirySessions.closedAt),
    ))
    .orderBy(desc(inquirySessions.closedAt))
    .limit(1)
  return row ? brandSessionRow(row) : undefined
}

// Closed-already-unsubscribed + chip-attach path lost the responseId CAS
// to a concurrent attach. Throwing here rolls back the freshly-inserted
// response row so exactly one rejection response is linked to one session.
// The catch handler re-reads the winner's responseId so the API response
// stays idempotent.
class SessionAttachLostError extends Error {
  constructor() {
    super('inquiry session feedback attached by concurrent request')
  }
}

// markDoNotContact:true is unconditional — landing-page unsubscribe is
// always a hard opt-out, overriding the conditional feedbackForcesDoNotContact
// logic that's used for email-reply rejections.
//
// This function accepts both open sessions and already-unsubscribed sessions
// so the landing UX can split the action: a first chip-less call closes the
// session immediately on the user's tap (CAN-SPAM/CASL: opt-out signal must
// be honored even if the user closes the tab before picking a chip), and an
// optional follow-up call attaches feedback when the user picks a chip after
// the fact. Already-closed sessions with non-unsubscribe outcomes (lead /
// inquired) are rejected.
export async function recordInquiryUnsubscribe(
  db: Db,
  shortId: ShortId,
  body: InquiryUnsubscribeInput,
): Promise<ServiceResult<{ unsubscribed: true; responseId: number | null }>> {
  const s = await selectRelevantSession(db, shortId)
  if (!s) return err('NOT_FOUND', 'Inquiry session not found')
  if (s.closedAt !== null && s.outcome !== 'unsubscribed') {
    return err('CONFLICT', `Session is already closed with outcome '${s.outcome}'`)
  }

  // Re-call on an already-unsubscribed session that already has feedback
  // attached: idempotent no-op. First-wins keeps semantics simple — the
  // recipient's first chip is the one of record.
  if (s.closedAt !== null && s.responseId !== null) {
    return ok({ unsubscribed: true, responseId: s.responseId })
  }

  // Re-call on already-unsubscribed without a chip + no chip in this call:
  // idempotent no-op.
  if (s.closedAt !== null && !body.primary_reason) {
    return ok({ unsubscribed: true, responseId: null })
  }

  let channel: Channel | null = null
  if (body.primary_reason) {
    const [log] = await db
      .select({ channel: outreachLogs.channel })
      .from(outreachLogs)
      .where(eq(outreachLogs.id, s.outreachLogId))
      .limit(1)
    if (!log) return err('NOT_FOUND', 'Outreach log not found')
    channel = log.channel
  }

  const now = new Date()
  const feedback: RejectionFeedbackV1 | null = body.primary_reason
    ? {
        version: 1,
        primary_reason: body.primary_reason,
        ...(body.free_text ? { free_text: body.free_text } : {}),
        ...(body.consent ? { consent: body.consent } : {}),
        submitted_at: now.toISOString(),
      }
    : null

  try {
    // See recordMeetingRequestForSession for why db.transaction here is OK.
    return await db.transaction(async (tx) => {
      let responseId: number | null = null
      if (feedback && channel) {
        const result = await recordResponse(tx as unknown as Db, s.tenantId, {
          outreachLogId: s.outreachLogId,
          channel,
          content: body.free_text ?? '(unsubscribe via inquiry landing)',
          sentiment: 'negative',
          responseType: 'rejection',
          receivedAt: now.toISOString(),
          markDoNotContact: true,
          rejectionFeedback: feedback,
        })
        if (!result.ok) return result
        if (result.value.id === undefined) {
          throw new Error('Failed to insert rejection response')
        }
        responseId = result.value.id
      } else if (s.closedAt === null) {
        // Open + chip-less path: skip the `responses` write but ratchet DNC
        // directly. status is intentionally not flipped — without a response
        // there's no signal to derive 'rejected' / 'deferred' from.
        await tx
          .update(prospects)
          .set({ doNotContact: true, updatedAt: now })
          .where(eq(prospects.id, s.prospectId))
      }

      if (s.closedAt === null) {
        // Open session: close it. SessionRaceError on concurrent close.
        const [updated] = await tx
          .update(inquirySessions)
          .set({
            outcome: 'unsubscribed',
            ...(responseId !== null ? { responseId } : {}),
            closedAt: now,
          })
          .where(and(eq(inquirySessions.id, s.id), isNull(inquirySessions.closedAt)))
          .returning({ id: inquirySessions.id })

        if (!updated) throw new SessionRaceError()
      } else if (responseId !== null) {
        // Already unsubscribed; this call attached feedback. Conditional CAS
        // on responseId keeps first-wins. On 0 rows affected, throw so the
        // transaction rolls back the just-inserted response row — otherwise
        // concurrent chip picks would each commit a response with only one
        // linked from the session.
        const [updated] = await tx
          .update(inquirySessions)
          .set({ responseId })
          .where(and(eq(inquirySessions.id, s.id), isNull(inquirySessions.responseId)))
          .returning({ id: inquirySessions.id })
        if (!updated) throw new SessionAttachLostError()
      }

      return ok({ unsubscribed: true, responseId })
    })
  } catch (e) {
    if (e instanceof SessionRaceError) {
      return err('CONFLICT', 'Inquiry session is no longer open')
    }
    if (e instanceof SessionAttachLostError) {
      const [winner] = await db
        .select({ responseId: inquirySessions.responseId })
        .from(inquirySessions)
        .where(eq(inquirySessions.id, s.id))
        .limit(1)
      const winnerResponseId =
        winner?.responseId === null || winner?.responseId === undefined
          ? null
          : (winner.responseId)
      return ok({ unsubscribed: true, responseId: winnerResponseId })
    }
    throw e
  }
}

export const INQUIRY_CHAT_TURNS_MAX = 5

export type InquiryLandingSession = {
  id: number
  outcome: InquiryOutcome
  chatTurnsUsed: number
  chatTurnsMax: number
  closed: boolean
}

export type InquiryLandingPayload = {
  shortId: ShortId | null
  preview: boolean

  // project_settings.sender_display_name verbatim. Null when unset — frontend
  // then omits the personal-name slot of the landing header (and falls back
  // to senderCompany / a generic phrasing in body copy). We deliberately do
  // NOT fall back to tenants.name: that column is the internal workspace
  // label and is documented as never being sent to recipients.
  senderName: string | null
  // project_settings.sender_company_name. Null when the user hasn't set it
  // on /inquiry-settings — the landing then shows "From {senderName}"
  // without an "at {company}" suffix. Distinct from tenants.legal_name
  // (compliance footer, never shown here) and tenants.name (internal
  // workspace label that is documented as never sent to recipients).
  senderCompany: string | null
  // project_settings.sender_job_title. Optional role displayed alongside
  // senderName / senderCompany on the landing header
  // ("From {senderName}, {senderJobTitle} at {senderCompany}"). Null omits
  // the role slot.
  senderJobTitle: string | null
  brandColor: string | null
  brandLogoUrl: string | null

  // Greeting hints. Null on preview (no real prospect) or for legacy
  // prospect rows missing contact_name. Frontend falls back gracefully.
  recipientName: string | null
  recipientOrganization: string | null

  oneLiner: string | null
  videoUrl: string | null
  pdfUrl: string | null
  // CTA the landing page renders. 'meeting' = Book/Request a meeting (the
  // human-sales path; schedulingUrl optional). 'signup' = Sign up button
  // linking to signupUrl (self-serve, no human follow-up). The two
  // variants are mutually exclusive — the landing renders one CTA, never
  // both. Variant carries only the URL each mode actually needs, so
  // invalid combinations (signup without a destination) cannot exist on
  // the wire.
  cta:
    | { type: 'meeting'; schedulingUrl: string | null }
    | { type: 'signup'; signupUrl: string }

  // chatEnabled is server-authoritative — clients must not infer it from
  // other fields and must not render the chat input when it's false.
  chatEnabled: boolean

  // Up to FAQ_SUGGESTIONS_MAX `Q:` lines parsed from inquiryChatBrief, in the
  // order they appear. Empty array when the brief is null, has no Q/A
  // structure, or chat is disabled. Frontend renders these as 1-tap chips.
  chatFaqSuggestions: string[]

  session: InquiryLandingSession | null
}

const previewableSettingsCols = {
  senderDisplayName: projectSettings.senderDisplayName,
  senderCompanyName: projectSettings.senderCompanyName,
  senderJobTitle: projectSettings.senderJobTitle,
  inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
  inquiryChatBrief: projectSettings.inquiryChatBrief,
  inquiryOneLiner: projectSettings.inquiryOneLiner,
  inquiryVideoUrl: projectSettings.inquiryVideoUrl,
  inquiryPdfUrl: projectSettings.inquiryPdfUrl,
  inquiryBrandColor: projectSettings.inquiryBrandColor,
  inquiryBrandLogoUrl: projectSettings.inquiryBrandLogoUrl,
  inquiryCtaType: projectSettings.inquiryCtaType,
  inquiryCtaUrl: projectSettings.inquiryCtaUrl,
}

// Read-side defense-in-depth. The write path now refuses non-https URLs, but
// rows persisted before that constraint may still hold http: / javascript: /
// data: URLs that would render in <a href> / <a download> on the recipient
// landing — javascript: in particular executes on click. Strip anything that
// is not https here so the landing payload is safe regardless of how the row
// got into the table.
const httpsOrNull = (u: string | null): string | null =>
  u !== null && isHttpsUrl(u) ? u : null

// Build the discriminated CTA payload. signup mode requires a non-null,
// https URL — the write path enforces this, but a row that pre-dates the
// constraint or stores a non-https URL falls back to meeting notify-only
// here so the landing page always renders a coherent CTA.
const buildCta = (
  type: InquiryCtaType | null,
  rawUrl: string | null,
): InquiryLandingPayload['cta'] => {
  const url = httpsOrNull(rawUrl)
  if (type === 'signup' && url !== null) {
    return { type: 'signup', signupUrl: url }
  }
  return { type: 'meeting', schedulingUrl: url }
}

// All "not found / revoked / outreach gone / landing disabled" paths
// collapse to the same NOT_FOUND so scanners can't probe short_id existence.
export async function loadLandingContext(
  db: Db,
  shortId: ShortId,
): Promise<ServiceResult<InquiryLandingPayload>> {
  // Single-roundtrip join: inquiry_tokens (auth) → outreach_logs →
  // project_settings (left; null on legacy projects) → prospect →
  // organization. Prospect/organization joins are inner because the token
  // is meaningless without a target row to display the page for.
  const [row] = await db
    .select({
      tokenTenantId: inquiryTokens.tenantId,
      tokenProspectId: inquiryTokens.prospectId,
      tokenOutreachLogId: inquiryTokens.outreachLogId,
      tokenCreatedAt: inquiryTokens.createdAt,
      tokenRevokedAt: inquiryTokens.revokedAt,
      ...previewableSettingsCols,
      prospectContactName: prospects.contactName,
      organizationName: organizations.name,
    })
    .from(inquiryTokens)
    .innerJoin(outreachLogs, eq(outreachLogs.id, inquiryTokens.outreachLogId))
    .leftJoin(projectSettings, eq(projectSettings.projectId, outreachLogs.projectId))
    .innerJoin(prospects, eq(prospects.id, inquiryTokens.prospectId))
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(and(eq(inquiryTokens.shortId, shortId), isNull(inquiryTokens.revokedAt)))
    .limit(1)

  if (!row) return err('NOT_FOUND', 'Inquiry link is no longer valid')

  // `=== false` only — left-join null (no project_settings row) honors
  // the column default of true.
  if (row.inquiryLandingEnabled === false) {
    return err('NOT_FOUND', 'Inquiry link is no longer valid')
  }

  const token: InquiryTokenRow = {
    shortId,
    tenantId: asTenantId(row.tokenTenantId),
    prospectId: row.tokenProspectId,
    outreachLogId: row.tokenOutreachLogId,
    createdAt: row.tokenCreatedAt,
    revokedAt: row.tokenRevokedAt,
  }

  const opened = await openLandingSession(db, token)
  // Compose / persist the per-prospect chat snapshot once at session open;
  // subsequent chat turns read it verbatim so the LLM context stays stable
  // across the conversation. Skipped when chat is disabled (no project
  // brief) or when the snapshot already exists from a prior visit.
  const session = await ensureSessionContextSnapshot(db, opened, row.inquiryChatBrief)

  return ok({
    shortId,
    preview: false,
    senderName: row.senderDisplayName,
    senderCompany: row.senderCompanyName,
    senderJobTitle: row.senderJobTitle,
    brandColor: row.inquiryBrandColor,
    brandLogoUrl: httpsOrNull(row.inquiryBrandLogoUrl),
    recipientName: row.prospectContactName,
    recipientOrganization: row.organizationName,
    oneLiner: row.inquiryOneLiner,
    videoUrl: httpsOrNull(row.inquiryVideoUrl),
    pdfUrl: httpsOrNull(row.inquiryPdfUrl),
    cta: buildCta(row.inquiryCtaType, row.inquiryCtaUrl),
    chatEnabled: nonEmpty(row.inquiryChatBrief),
    chatFaqSuggestions: extractFaqQuestions(row.inquiryChatBrief),
    session: {
      id: session.id,
      outcome: session.outcome,
      chatTurnsUsed: session.chatTurnsUsed,
      chatTurnsMax: INQUIRY_CHAT_TURNS_MAX,
      closed: session.closedAt !== null,
    },
  })
}

export const inquiryPreviewQuerySchema = z.object({
  projectId: projectIdSchema,
})
export type InquiryPreviewQuery = z.infer<typeof inquiryPreviewQuerySchema>

export async function loadPreviewContext(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<InquiryLandingPayload>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const [row] = await db
    .select({
      ...previewableSettingsCols,
    })
    .from(projects)
    .leftJoin(projectSettings, eq(projectSettings.projectId, projects.id))
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!row) return err('NOT_FOUND', 'Project not found')

  return ok({
    shortId: null,
    preview: true,
    senderName: row.senderDisplayName,
    senderCompany: row.senderCompanyName,
    senderJobTitle: row.senderJobTitle,
    brandColor: row.inquiryBrandColor,
    brandLogoUrl: httpsOrNull(row.inquiryBrandLogoUrl),
    // Preview has no real prospect.
    recipientName: null,
    recipientOrganization: null,
    oneLiner: row.inquiryOneLiner,
    videoUrl: httpsOrNull(row.inquiryVideoUrl),
    pdfUrl: httpsOrNull(row.inquiryPdfUrl),
    cta: buildCta(row.inquiryCtaType, row.inquiryCtaUrl),
    chatEnabled: nonEmpty(row.inquiryChatBrief),
    chatFaqSuggestions: extractFaqQuestions(row.inquiryChatBrief),
    session: null,
  })
}

function nonEmpty(s: string | null): boolean {
  return s !== null && s.trim().length > 0
}

// Outcome is intentionally not touched — escalation to 'lead' goes through
// recordMeetingRequest, and the natural close path keeps 'inquired'.
export async function closeSessionWithSummary(
  db: Db,
  sessionId: number,
  summary: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(inquirySessions)
    .set({ derivedSummary: summary, closedAt: now })
    .where(and(eq(inquirySessions.id, sessionId), isNull(inquirySessions.closedAt)))
}

export type InquirySessionMessage = {
  role: InquiryMessageRole
  content: string
  createdAt: Date
}

export type InquirySessionSummaryEntry = {
  id: number
  outcome: InquiryOutcome
  meetingRequestSource: MeetingRequestSource | null
  derivedSummary: string | null
  chatTurnsUsed: number
  openedAt: Date
  closedAt: Date | null
  messages: InquirySessionMessage[]
}

export type InquirySessionSummary = {
  shortId: ShortId
  tokenRevokedAt: Date | null
  prospect: {
    id: number
    name: string
    contactName: string | null
    email: string | null
  }
  outreach: {
    id: number
    channel: Channel
    sentAt: Date | null
  }
  sessions: InquirySessionSummaryEntry[]
}

// A revoked token is still readable so the sender can audit past visits —
// only the recipient-facing landing rejects revoked tokens.
export async function loadInquirySessionSummary(
  db: Db,
  tenantId: TenantId,
  shortId: ShortId,
): Promise<ServiceResult<InquirySessionSummary>> {
  const [head] = await db
    .select({
      shortId: inquiryTokens.shortId,
      tokenRevokedAt: inquiryTokens.revokedAt,
      prospectId: prospects.id,
      prospectName: prospects.name,
      prospectContactName: prospects.contactName,
      prospectEmail: prospects.email,
      outreachId: outreachLogs.id,
      outreachChannel: outreachLogs.channel,
      outreachSentAt: outreachLogs.sentAt,
    })
    .from(inquiryTokens)
    .innerJoin(prospects, eq(prospects.id, inquiryTokens.prospectId))
    .innerJoin(outreachLogs, eq(outreachLogs.id, inquiryTokens.outreachLogId))
    .where(and(eq(inquiryTokens.shortId, shortId), eq(inquiryTokens.tenantId, tenantId)))
    .limit(1)

  if (!head) return err('NOT_FOUND', 'Inquiry token not found')

  const sessionRows = await db
    .select({
      id: inquirySessions.id,
      outcome: inquirySessions.outcome,
      meetingRequestSource: inquirySessions.meetingRequestSource,
      derivedSummary: inquirySessions.derivedSummary,
      chatTurnsUsed: inquirySessions.chatTurnsUsed,
      openedAt: inquirySessions.openedAt,
      closedAt: inquirySessions.closedAt,
    })
    .from(inquirySessions)
    .where(eq(inquirySessions.shortId, shortId))
    .orderBy(desc(inquirySessions.openedAt))

  const sessionIds = sessionRows.map((s) => s.id)
  const messageRows = sessionIds.length === 0
    ? []
    : await db
        .select({
          sessionId: inquiryMessages.sessionId,
          role: inquiryMessages.role,
          content: inquiryMessages.content,
          createdAt: inquiryMessages.createdAt,
        })
        .from(inquiryMessages)
        .where(inArray(inquiryMessages.sessionId, sessionIds))
        .orderBy(asc(inquiryMessages.createdAt))

  const messagesBySession = new Map<number, InquirySessionMessage[]>()
  for (const m of messageRows) {
    let bucket = messagesBySession.get(m.sessionId)
    if (!bucket) {
      bucket = []
      messagesBySession.set(m.sessionId, bucket)
    }
    bucket.push({ role: m.role, content: m.content, createdAt: m.createdAt })
  }

  return ok({
    shortId: asShortId(head.shortId),
    tokenRevokedAt: head.tokenRevokedAt,
    prospect: {
      id: head.prospectId,
      name: head.prospectName,
      contactName: head.prospectContactName,
      email: head.prospectEmail,
    },
    outreach: {
      id: head.outreachId,
      channel: head.outreachChannel,
      sentAt: head.outreachSentAt,
    },
    sessions: sessionRows.map((s) => ({
      id: s.id,
      outcome: s.outcome,
      meetingRequestSource: s.meetingRequestSource,
      derivedSummary: s.derivedSummary,
      chatTurnsUsed: s.chatTurnsUsed,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      messages: messagesBySession.get(s.id) ?? [],
    })),
  })
}
