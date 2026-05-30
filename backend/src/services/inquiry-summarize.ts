import { eq, and, isNull } from 'drizzle-orm'
import {
  inquirySessions,
  outreachLogs,
  prospects,
  gmailCredentials,
  tenantMembers,
} from '../db/schema'
import type { Db } from '../db/connection'
import { asTenantId } from '../domain/ids'
import { callOpenAIResponses, type OpenAIEnv } from './openai'
import {
  closeSessionWithSummary,
  loadInquiryTranscript,
  recordMeetingRequestForSession,
  type MeetingRequestTarget,
} from './inquiry-session'
import { sendGmailForUser } from '../auth/google'

// Env subset for the lead-notification email path. Carries the bindings
// sendGmailForUser + the dashboard URL need; intentionally narrower than
// the chat path so notifyLeadByEmail's signature names exactly what it uses.
export type LeadNotifyEnv = {
  APP_URL: string
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  E2E_RECIPIENT_OVERRIDE?: string
}

const SUMMARIZE_MODEL = 'gpt-5.4-mini'
const SUMMARIZE_TEMPERATURE = 0.2
const SUMMARIZE_MAX_OUTPUT_TOKENS = 300

export type SummarizeTrigger = 'cap' | 'idle'

// Throws on OpenAI failure so the caller can decide whether to fall back to
// a non-LLM close (see inquiry-chat.ts).
export async function generateSessionSummary(
  db: Db,
  env: OpenAIEnv & LeadNotifyEnv,
  sessionId: number,
  trigger: SummarizeTrigger,
): Promise<void> {
  const target = await loadMeetingRequestTarget(db, sessionId)
  if (!target) return

  const transcript = await loadInquiryTranscript(db, sessionId)
  if (transcript.length === 0) {
    // No user/assistant exchanges — nothing to summarize.
    await closeSessionWithSummary(db, sessionId, '(session closed before any messages)')
    return
  }

  const llm = await callOpenAIResponses({
    apiKey: env.OPENAI_API_KEY,
    model: SUMMARIZE_MODEL,
    instructions: buildSummarizeInstructions(trigger),
    input: transcript,
    temperature: SUMMARIZE_TEMPERATURE,
    maxOutputTokens: SUMMARIZE_MAX_OUTPUT_TOKENS,
  })

  const parsed = parseSummaryJson(llm.outputText)

  // 'lead' escalates the session and creates a meeting_request response row.
  // Anything else (incl. parse failure / missing field) stays as 'inquired'
  // — better to under-flag a lead than fabricate one.
  if (parsed?.outcome === 'lead') {
    const escalated = await recordMeetingRequestForSession(db, target, 'chat', parsed.summary)
    // CONFLICT = a concurrent close (unsubscribe / request-meeting button)
    // already finalised the session and the tx rolled back, including the
    // recordResponse insert. The concurrent path's outcome wins; skip email.
    if (!escalated.ok) return
    // Best-effort email notification — failures don't unwind the lead. The
    // dashboard banner (frontend reads inquiry_sessions WHERE outcome='lead')
    // is the always-on path; email is a nudge for operators not staring at
    // the app.
    try {
      await notifyLeadByEmail(db, env, sessionId, parsed.summary)
    } catch {
      // Swallow — Gmail not connected, refresh token revoked, send rejected,
      // etc. None of these should fail the lead escalation.
    }
  } else {
    await closeSessionWithSummary(db, sessionId, parsed?.summary ?? llm.outputText.trim())
  }
}

async function loadMeetingRequestTarget(
  db: Db,
  sessionId: number,
): Promise<MeetingRequestTarget | null> {
  const [row] = await db
    .select({
      sessionId: inquirySessions.id,
      tenantId: inquirySessions.tenantId,
      outreachLogId: inquirySessions.outreachLogId,
      channel: outreachLogs.channel,
    })
    .from(inquirySessions)
    .innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
    .where(and(eq(inquirySessions.id, sessionId), isNull(inquirySessions.closedAt)))
    .limit(1)
  return row
    ? { ...row, tenantId: asTenantId(row.tenantId) }
    : null
}

function buildSummarizeInstructions(trigger: SummarizeTrigger): string {
  const triggerNote =
    trigger === 'cap'
      ? 'The conversation hit its 5-turn cap.'
      : 'The recipient walked away — the conversation timed out.'
  return [
    'You are summarizing an inquiry-page chat between a potential customer (user) and an AI sales assistant (assistant) on behalf of a vendor.',
    triggerNote,
    '',
    'Produce a JSON object with two keys, no surrounding prose, no markdown fences:',
    '{',
    '  "summary": "exactly 3 short lines separated by \\n: (1) what the recipient was interested in, (2) the key question or objection raised, (3) the most actionable next step for the vendor",',
    '  "outcome": "lead" if the recipient explicitly asked for a meeting/demo/contact OR sent strong buying signals (pricing, timeline, decision-maker question). Otherwise "inquired".',
    '}',
    '',
    'Be conservative on "lead" — only escalate when the recipient clearly wants a real conversation with a human. Casual product questions remain "inquired".',
    'Reply with the JSON object only. Do not wrap it in code fences. Do not add explanation.',
  ].join('\n')
}

export type ParsedSummary = {
  summary: string
  outcome: 'inquired' | 'lead'
}

// Sends a self-notification email via the project owner's own Gmail. Skips
// silently when the tenant has no gmail_credentials row (form/SNS-only
// projects). The recipient and the From: are the same address — operators
// see the lead arriving in their own inbox, no separate transactional
// transport (Resend etc.) needed.
async function notifyLeadByEmail(
  db: Db,
  env: LeadNotifyEnv,
  sessionId: number,
  summary: string,
): Promise<void> {
  const [row] = await db
    .select({
      tenantId: gmailCredentials.tenantId,
      userId: gmailCredentials.userId,
      ownerEmail: gmailCredentials.email,
      prospectName: prospects.name,
      prospectEmail: prospects.email,
    })
    .from(inquirySessions)
    .innerJoin(prospects, eq(prospects.id, inquirySessions.prospectId))
    .innerJoin(tenantMembers, eq(tenantMembers.tenantId, inquirySessions.tenantId))
    .innerJoin(
      gmailCredentials,
      and(
        eq(gmailCredentials.tenantId, tenantMembers.tenantId),
        eq(gmailCredentials.userId, tenantMembers.userId),
      ),
    )
    .where(eq(inquirySessions.id, sessionId))
    .limit(1)

  if (!row) return

  const dashboardUrl = `${env.APP_URL}/check-results`
  const prospectLine = row.prospectEmail
    ? `${row.prospectName} <${row.prospectEmail}>`
    : row.prospectName
  const subject = `[LeadAce] New lead from ${row.prospectName}`
  const body = [
    `A recipient just escalated to a lead via the inquiry chat.`,
    '',
    `Prospect: ${prospectLine}`,
    '',
    'Summary:',
    summary,
    '',
    `Open dashboard: ${dashboardUrl}`,
  ].join('\n')

  await sendGmailForUser(db, {
    tenantId: asTenantId(row.tenantId),
    userId: row.userId,
    encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    to: [row.ownerEmail],
    subject,
    body,
    e2eRecipientOverride: env.E2E_RECIPIENT_OVERRIDE ?? null,
  })
}

export function parseSummaryJson(raw: string): ParsedSummary | null {
  // Models occasionally wrap JSON in code fences despite instructions; strip
  // them before parsing.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  try {
    const data = JSON.parse(stripped) as unknown
    if (typeof data !== 'object' || data === null) return null
    const obj = data as Record<string, unknown>
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : null
    const outcome = obj.outcome === 'lead' ? 'lead' : 'inquired'
    if (!summary || summary.length === 0) return null
    return { summary, outcome }
  } catch {
    return null
  }
}
