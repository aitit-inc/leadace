import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import {
  prospects,
  organizations,
  orgSignalsGlobal,
  projectProspects,
  projectSettings,
} from '../db/schema'
import type { Db } from '../db/connection'
import { projectRefSchema, prospectIdSchema, type ProjectId, type TenantId } from '../domain/ids'
import { localeForCountry } from '../domain/locale'
import { ok, err, type ServiceResult } from './result'
import {
  callOpenAIResponses,
  OpenAIError,
  type OpenAIEnv,
  type OpenAIInputMessage,
} from './openai'
import { resolveProject } from './projects'
import { composeContextSnapshot, INQUIRY_CHAT_TURNS_MAX } from './inquiry-session'
import {
  buildSystemPrompt,
  CHAT_MODEL,
  CHAT_TEMPERATURE,
  CHAT_MAX_OUTPUT_TOKENS,
  type ChatPromptContext,
} from './inquiry-chat'

// Sender-side preview of the recipient inquiry chat. Stateless by design: it
// writes nothing (no session, messages, outcome, response, DNC, status, or
// lead email). The client carries the transcript on every turn, which is what
// makes the no-persistence guarantee structural. Model config is imported from
// inquiry-chat so the preview mirrors the live chat instead of drifting.

export const inquiryPreviewChatBodySchema = z.object({
  projectId: projectRefSchema,
  prospectId: prospectIdSchema.optional(),
  transcript: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(INQUIRY_CHAT_TURNS_MAX * 2)
    .default([]),
  message: z.string().min(1).max(2000),
})
export type InquiryPreviewChatInput = z.infer<typeof inquiryPreviewChatBodySchema>

export type InquiryPreviewChatResult = {
  assistantMessage: string
  chatTurnsUsed: number
  chatTurnsMax: number
  sessionClosed: false
  reachedTurnLimit: boolean
}

export async function runInquiryPreviewChat(
  db: Db,
  env: OpenAIEnv,
  tenantId: TenantId,
  input: InquiryPreviewChatInput,
): Promise<ServiceResult<InquiryPreviewChatResult>> {
  const resolved = await resolveProject(db, tenantId, input.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [settings] = await db
    .select({
      brief: projectSettings.inquiryChatBrief,
      senderName: projectSettings.senderDisplayName,
      senderCompany: projectSettings.senderCompanyName,
      senderJobTitle: projectSettings.senderJobTitle,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)

  const projectBrief = settings?.brief ?? null
  if (!projectBrief || projectBrief.trim().length === 0) {
    return err('PRECONDITION_FAILED', 'Chat is not configured for this project')
  }

  // The client-held transcript is the only turn record, so count from it.
  const userTurns = input.transcript.filter((m) => m.role === 'user').length
  if (userTurns >= INQUIRY_CHAT_TURNS_MAX) {
    return err(
      'UNPROCESSABLE',
      'Chat turn limit reached',
      `This preview conversation has used all ${INQUIRY_CHAT_TURNS_MAX} turns.`,
    )
  }

  const promptCtx = await loadPreviewPromptContext(db, projectId, input.prospectId ?? null, {
    brief: projectBrief,
    senderName: settings?.senderName ?? null,
    senderCompany: settings?.senderCompany ?? null,
    senderJobTitle: settings?.senderJobTitle ?? null,
  })

  const turnNumber = userTurns + 1
  const instructions = buildSystemPrompt(promptCtx, turnNumber)

  const apiInput: OpenAIInputMessage[] = [
    ...input.transcript.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.message },
  ]

  let assistantMessage: string
  try {
    const response = await callOpenAIResponses({
      apiKey: env.OPENAI_API_KEY,
      model: CHAT_MODEL,
      instructions,
      input: apiInput,
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

  return ok({
    assistantMessage,
    chatTurnsUsed: turnNumber,
    chatTurnsMax: INQUIRY_CHAT_TURNS_MAX,
    sessionClosed: false,
    reachedTurnLimit: turnNumber >= INQUIRY_CHAT_TURNS_MAX,
  })
}

type SenderFields = {
  brief: string
  senderName: string | null
  senderCompany: string | null
  senderJobTitle: string | null
}

// A prospect not linked to this project falls back to the generic brief
// rather than erroring — the picker only offers in-project prospects anyway.
async function loadPreviewPromptContext(
  db: Db,
  projectId: ProjectId,
  prospectId: number | null,
  sender: SenderFields,
): Promise<ChatPromptContext> {
  if (prospectId === null) {
    return { ...sender, locale: 'en', recipientName: null, recipientOrganization: null }
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
      organizationCountry: organizations.country,
      signals: orgSignalsGlobal.signals,
      signalsUpdatedAt: orgSignalsGlobal.signalsUpdatedAt,
    })
    .from(projectProspects)
    .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(
      and(
        eq(projectProspects.projectId, projectId),
        eq(projectProspects.prospectId, prospectId),
      ),
    )
    .limit(1)

  if (!row) {
    return { ...sender, locale: 'en', recipientName: null, recipientOrganization: null }
  }

  const snapshot = composeContextSnapshot({
    projectInquiryChatBrief: sender.brief,
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

  return {
    brief: snapshot.brief,
    locale: localeForCountry(row.prospectCountry ?? row.organizationCountry),
    senderName: sender.senderName,
    senderCompany: sender.senderCompany,
    senderJobTitle: sender.senderJobTitle,
    recipientName: row.contactName,
    recipientOrganization: row.organizationName,
  }
}
