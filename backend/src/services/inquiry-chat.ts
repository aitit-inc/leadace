import { eq, and, isNull } from 'drizzle-orm'
import {
  inquirySessions,
  inquiryTokens,
  outreachLogs,
  projectSettings,
  prospects,
  organizations,
} from '../db/schema'
import type { Db } from '../db/connection'
import { asTenantId, type ShortId, type TenantId } from '../domain/ids'
import { localeForCountry, type Locale } from '../domain/locale'
import { ok, err, type ServiceResult } from './result'
import {
  callOpenAIResponses,
  OpenAIError,
  type OpenAIEnv,
  type OpenAIInputMessage,
} from './openai'
import {
  getRemainingChatQuota,
  isChatQuotaExhausted,
  formatChatQuotaError,
} from './plan-limits'
import {
  appendInquiryMessage,
  closeSessionWithSummary,
  markSessionInquired,
  reserveChatTurnSlot,
  loadInquiryTranscript,
  SessionRaceError,
  INQUIRY_CHAT_TURNS_MAX,
} from './inquiry-session'
import { generateSessionSummary, type LeadNotifyEnv } from './inquiry-summarize'
import type { Edition } from '../domain/edition'

// Chat path needs OpenAI directly + LeadNotifyEnv via the lead-escalation
// callback in generateSessionSummary. Two narrow aliases compose here so
// notifyLeadByEmail's signature isn't forced to declare OPENAI_API_KEY just
// because it sits behind the same chat run.
type InquiryChatEnv = OpenAIEnv & LeadNotifyEnv

// Lazy idle-timeout. Sessions left untouched longer than this are considered
// abandoned — the next request closes them with a summary and refuses the new
// message so the recipient gets a clean error and can refresh.
const INQUIRY_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// gpt-5.4-mini chosen for cost/latency on the chat path. Exported so the
// stateless preview path (inquiry-preview-chat.ts) reuses the exact same model
// config instead of duplicating it — the preview must mirror the live chat,
// not drift from it.
export const CHAT_MODEL = 'gpt-5.4-mini'
export const CHAT_TEMPERATURE = 0.6
export const CHAT_MAX_OUTPUT_TOKENS = 400

export type InquiryChatRunResult = {
  assistantMessage: string
  chatTurnsUsed: number
  chatTurnsMax: number
  sessionClosed: boolean
  // True when chat-turn cap was reached on this turn — the caller (frontend)
  // should hide the chat input and surface the "Request meeting" button.
  reachedTurnLimit: boolean
}

// The fields buildSystemPrompt reads. Shared with the stateless preview chat
// path so neither caller fabricates session state. `brief` is always required
// (chat is gated on a non-empty project brief). Every other field is nullable
// because each is a genuinely optional input the prompt branches on: sender_*
// are unset until the user configures them, recipient_* are absent on the
// no-prospect preview / legacy sessions.
export type ChatPromptContext = {
  brief: string
  // Recipient language. 'ja' makes the assistant reply in polite business
  // Japanese; 'en' keeps it English. Derived from the effective recipient
  // country (prospect override → organization).
  locale: Locale
  // project_settings.sender_display_name verbatim. Null when unset — the
  // system prompt then frames the AI as representing the company (or, if
  // both are null, the offering generically). Deliberately NOT falling back
  // to tenants.name (internal workspace label, never to be sent to
  // recipients per the schema contract).
  senderName: string | null
  // project_settings.sender_company_name. Null when the user hasn't set it.
  // When present, the system prompt frames the AI as representing the
  // company (with senderName as the personal voice when also set).
  senderCompany: string | null
  // project_settings.sender_job_title. Optional role appended after senderName
  // in the system prompt's senderIntro. Has no effect when senderName is null.
  senderJobTitle: string | null
  // Drawn from inquiry_sessions.context_snapshot.prospectHints (populated at
  // session open). Null on legacy sessions whose snapshot was never composed
  // — buildSystemPrompt then falls back to a generic visitor framing.
  recipientName: string | null
  recipientOrganization: string | null
}

type ChatContext = ChatPromptContext & {
  sessionId: number
  tenantId: TenantId
  chatTurnsUsed: number
  openedAt: Date
}

export async function runInquiryChat(
  db: Db,
  env: InquiryChatEnv,
  edition: Edition,
  shortId: ShortId,
  userMessage: string,
): Promise<ServiceResult<InquiryChatRunResult>> {
  const ctxResult = await loadChatContext(db, shortId)
  if (!ctxResult.ok) return ctxResult
  const ctx = ctxResult.value

  const [transcript, quota] = await Promise.all([
    loadInquiryTranscript(db, ctx.sessionId),
    getRemainingChatQuota(db, ctx.tenantId, edition),
  ])
  const lastActivityAt = transcript.at(-1)?.createdAt ?? ctx.openedAt

  // Idle-close BEFORE the per-session cap check so a long-abandoned session
  // doesn't keep returning 422 — the recipient should be told to refresh.
  if (Date.now() - lastActivityAt.getTime() >= INQUIRY_IDLE_TIMEOUT_MS) {
    return idleCloseAndReject(db, env, ctx)
  }

  if (ctx.chatTurnsUsed >= INQUIRY_CHAT_TURNS_MAX) {
    return err(
      'UNPROCESSABLE',
      'Chat turn limit reached',
      `This conversation has used all ${INQUIRY_CHAT_TURNS_MAX} turns. Use the "Request meeting" button to continue.`,
    )
  }

  if (isChatQuotaExhausted(quota)) {
    return err('FORBIDDEN', 'Chat limit reached', formatChatQuotaError(quota))
  }

  const input: OpenAIInputMessage[] = [
    ...transcript.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  const turnNumber = ctx.chatTurnsUsed + 1
  const instructions = buildSystemPrompt(ctx, turnNumber)

  let assistantMessage: string
  try {
    const response = await callOpenAIResponses({
      apiKey: env.OPENAI_API_KEY,
      model: CHAT_MODEL,
      instructions,
      input,
      temperature: CHAT_TEMPERATURE,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    })
    assistantMessage = response.outputText
  } catch (e) {
    if (e instanceof OpenAIError) {
      return err('BAD_GATEWAY', 'Chat backend unavailable', e.message)
    }
    throw e
  }

  // Reserve the turn slot first (atomic check on closed_at + cap), then write
  // both messages — all in one transaction so a concurrent close /
  // concurrent-turn race rolls the messages back too.
  let newTurnsUsed: number
  try {
    // db.transaction here is legitimate: this service is only called from the
    // public token-authenticated inquiry routes, which use createDb() directly
    // and bypass the RLS middleware (see CLAUDE.md "Multi-Tenancy"). The `db`
    // received here is therefore a raw connection, not a tx already opened by
    // rls.ts — opening one here does not nest, so postgres-js's SAVEPOINT
    // semantics don't apply.
    newTurnsUsed = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db
      const reserved = await reserveChatTurnSlot(txDb, ctx.sessionId)
      await appendInquiryMessage(txDb, ctx.sessionId, ctx.tenantId, 'user', userMessage)
      await appendInquiryMessage(txDb, ctx.sessionId, ctx.tenantId, 'assistant', assistantMessage)
      // First user message flips the session from 'opened' to 'inquired'.
      // reserveChatTurnSlot returned 1 ↔ this turn was the first.
      if (reserved === 1) {
        await markSessionInquired(txDb, ctx.sessionId)
      }
      return reserved
    })
  } catch (e) {
    if (e instanceof SessionRaceError) {
      return err(
        'CONFLICT',
        'Inquiry session is no longer open',
        'Refresh the page to start a new conversation.',
      )
    }
    throw e
  }

  const reachedTurnLimit = newTurnsUsed >= INQUIRY_CHAT_TURNS_MAX
  let sessionClosed = false

  if (reachedTurnLimit) {
    // Best-effort summarize. Failures don't fail the user-visible turn — the
    // chat reply already landed in inquiry_messages and the cap is enforced.
    try {
      await generateSessionSummary(db, env, ctx.sessionId, 'cap')
      sessionClosed = true
    } catch {
      // Leave session open; an idle-timeout pass will retry the summary.
      sessionClosed = false
    }
  }

  return ok({
    assistantMessage,
    chatTurnsUsed: newTurnsUsed,
    chatTurnsMax: INQUIRY_CHAT_TURNS_MAX,
    sessionClosed,
    reachedTurnLimit,
  })
}

async function loadChatContext(
  db: Db,
  shortId: ShortId,
): Promise<ServiceResult<ChatContext>> {
  // Single round-trip: open session + token + project_settings(brief) +
  // tenant.name. NOT_FOUND if the session is already closed, the token is
  // revoked, the chat brief is missing, or inquiry_landing_enabled=false —
  // we collapse all of those into the same error so scanners can't probe.
  const [row] = await db
    .select({
      sessionId: inquirySessions.id,
      sessionTenantId: inquirySessions.tenantId,
      sessionChatTurnsUsed: inquirySessions.chatTurnsUsed,
      sessionOpenedAt: inquirySessions.openedAt,
      sessionContextSnapshot: inquirySessions.contextSnapshot,
      tokenRevokedAt: inquiryTokens.revokedAt,
      brief: projectSettings.inquiryChatBrief,
      landingEnabled: projectSettings.inquiryLandingEnabled,
      senderDisplayName: projectSettings.senderDisplayName,
      senderCompanyName: projectSettings.senderCompanyName,
      senderJobTitle: projectSettings.senderJobTitle,
      prospectCountry: prospects.country,
      organizationCountry: organizations.country,
    })
    .from(inquirySessions)
    .innerJoin(inquiryTokens, eq(inquiryTokens.shortId, inquirySessions.shortId))
    .innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
    .innerJoin(projectSettings, eq(projectSettings.projectId, outreachLogs.projectId))
    .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(and(eq(inquirySessions.shortId, shortId), isNull(inquirySessions.closedAt)))
    .limit(1)

  if (!row) return err('NOT_FOUND', 'Inquiry session is no longer open')
  if (row.tokenRevokedAt !== null) return err('NOT_FOUND', 'Inquiry session is no longer open')
  if (!row.landingEnabled) return err('NOT_FOUND', 'Inquiry session is no longer open')

  // The per-session snapshot wins when present — it folds in the prospect
  // hypothesis and recent org signals on top of the project brief. Fall
  // back to the bare project-level brief for legacy sessions / projects
  // where snapshot composition was skipped.
  const effectiveBrief = row.sessionContextSnapshot?.brief ?? row.brief
  if (!effectiveBrief || effectiveBrief.trim().length === 0) {
    return err('PRECONDITION_FAILED', 'Chat is not configured for this project')
  }

  return ok({
    sessionId: row.sessionId,
    tenantId: asTenantId(row.sessionTenantId),
    chatTurnsUsed: row.sessionChatTurnsUsed,
    openedAt: row.sessionOpenedAt,
    brief: effectiveBrief,
    locale: localeForCountry(row.prospectCountry ?? row.organizationCountry),
    senderName: row.senderDisplayName,
    senderCompany: row.senderCompanyName,
    senderJobTitle: row.senderJobTitle,
    recipientName: row.sessionContextSnapshot?.prospectHints?.contactName ?? null,
    recipientOrganization: row.sessionContextSnapshot?.prospectHints?.organizationName ?? null,
  })
}

async function idleCloseAndReject(
  db: Db,
  env: InquiryChatEnv,
  ctx: ChatContext,
): Promise<ServiceResult<never>> {
  // Best-effort: if there were never any messages, just close (nothing to
  // summarize). Otherwise summarize-and-close. Either way, the request fails
  // with CONFLICT so the frontend can prompt for a refresh.
  if (ctx.chatTurnsUsed > 0) {
    try {
      await generateSessionSummary(db, env, ctx.sessionId, 'idle')
    } catch {
      // Fall through to a non-summarized close — better than re-opening a
      // stuck session forever.
      await closeSessionWithSummary(db, ctx.sessionId, '(session timed out)')
    }
  } else {
    await closeSessionWithSummary(db, ctx.sessionId, '(session timed out before any messages)')
  }

  return err(
    'CONFLICT',
    'Inquiry session timed out',
    'Refresh the page to start a new conversation.',
  )
}

export function buildSystemPrompt(ctx: ChatPromptContext, currentTurn: number): string {
  const visitorLine = describeVisitor(ctx)
  // Pick the most specific framing the operator gave us: company+person if
  // both, either alone, otherwise a generic phrasing. We do NOT use
  // tenants.name (internal workspace label). senderJobTitle is appended
  // after senderName when present (no-op without senderName).
  const speakerLabel = ctx.senderName
    ? ctx.senderJobTitle
      ? `${ctx.senderName} (${ctx.senderJobTitle})`
      : ctx.senderName
    : null
  const senderIntro =
    ctx.senderCompany && speakerLabel
      ? `You are an AI sales assistant for ${ctx.senderCompany}, speaking as ${speakerLabel}.`
      : ctx.senderCompany
        ? `You are an AI sales assistant for ${ctx.senderCompany}.`
        : speakerLabel
          ? `You are an AI sales assistant representing ${speakerLabel}.`
          : 'You are an AI sales assistant for this offering.'
  const offerOwner = ctx.senderCompany ?? ctx.senderName ?? 'this offering'
  const visitorClause = visitorLine ? ` ${visitorLine}` : ''
  // The recipient is a Japanese company — name the button as the JA landing
  // labels it and steer the model to Japanese output. Instructions stay in
  // English (the model follows the language directive reliably).
  const meetingButton =
    ctx.locale === 'ja'
      ? 'the "打ち合わせを依頼" (request a meeting) button'
      : 'the "Request a meeting" button'
  const lengthRule =
    ctx.locale === 'ja'
      ? '- Keep replies under ~300 Japanese characters. The recipient values their time.'
      : '- Keep replies under ~150 words. The recipient values their time.'
  return [
    senderIntro,
    `A potential customer${visitorClause} clicked an inquiry link from a cold-outreach message and is asking questions about the offering. Your job is to be genuinely helpful, concise, and honest.`,
    '',
    'Service description (the only authoritative source — do not invent capabilities beyond it):',
    ctx.brief,
    '',
    'Rules:',
    ...(ctx.locale === 'ja'
      ? [
          '- Always reply in natural, polite Japanese business language (です・ます調 / 敬語). The recipient is a Japanese company, even though these instructions are written in English.',
        ]
      : []),
    `- Stay strictly on the topic of ${offerOwner}'s offering. Politely decline unrelated questions.`,
    lengthRule,
    '- If you cannot answer with the information provided, say so honestly — never fabricate features, pricing, or guarantees.',
    `- If the recipient seems ready for a real conversation with a human, suggest using ${meetingButton} on this page.`,
    '- Do not ask for personal data (name, phone, address, payment).',
    '- Formatting: plain text by default. You MAY use **bold**, *italic*, and bullet/numbered lists when they genuinely improve readability. Do NOT use any other Markdown (no headings, code blocks, blockquotes, links, images, tables, or HTML). Prefer prose over lists for short answers.',
    `- This is turn ${currentTurn} of a maximum ${INQUIRY_CHAT_TURNS_MAX}. After turn ${INQUIRY_CHAT_TURNS_MAX}, the recipient must use ${meetingButton} to continue the conversation.`,
  ].join('\n')
}

function describeVisitor(ctx: ChatPromptContext): string {
  if (ctx.recipientName && ctx.recipientOrganization) {
    return `(${ctx.recipientName} from ${ctx.recipientOrganization})`
  }
  if (ctx.recipientName) return `(${ctx.recipientName})`
  if (ctx.recipientOrganization) return `(from ${ctx.recipientOrganization})`
  return ''
}
