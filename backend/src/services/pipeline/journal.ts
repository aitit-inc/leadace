// Stage: journal — the public one-day entry Ace writes for /live
// (daily-cycle/SKILL.md wrap-up, server-side). Anonymization is enforced at
// the save (services/documents → redactPublicJournal), so a rejected entry is
// rewritten once with the server's objection and otherwise left unpublished.
import { z } from 'zod'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection'
import { outreachLogs, responses } from '../../db/schema'
import type { ProjectId, TenantId } from '../../domain/ids'
import type { JobKind, JobResult } from '../../domain/jobs'
import { ok, type ServiceResult } from '../result'
import { callGeminiJson, GeminiError, HOSTED_MODEL } from '../gemini'
import { getRejectionFeedbackSummaryById } from '../responses'
import { getProjectSettings } from '../project-settings'
import { saveDocument } from '../documents'
import { noProgress, STAGE_CALLER, type HostedEnv, type ProgressFn } from './context'
import { languageNameOf } from '../../domain/locale'
import { utcDateKey } from '../../domain/time'
import { runWithRls } from '../../db/rls'

export type JournalResult = Extract<JobResult, { kind: 'journal' }>

export type CycleDigest = {
  stages: Array<{ kind: JobKind; summary: string }>
  decisions: string[]
}

const entrySchema = z.object({ entry: z.string().min(1).max(2000) })

async function todayCounts(db: Db, tenantId: TenantId, projectId: ProjectId, since: Date) {
  const [sentRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachLogs)
    .where(and(eq(outreachLogs.tenantId, tenantId), eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'sent'), gte(outreachLogs.sentAt, since)))
  const [replyRow] = await db
    .select({
      replies: sql<number>`count(*) filter (where ${responses.responseType} in ('reply', 'rejection', 'meeting_request'))::int`,
      positive: sql<number>`count(*) filter (where ${responses.sentiment} = 'positive')::int`,
      bounces: sql<number>`count(*) filter (where ${responses.responseType} = 'bounce')::int`,
    })
    .from(responses)
    .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
    .where(and(eq(responses.tenantId, tenantId), eq(outreachLogs.projectId, projectId), gte(responses.receivedAt, since), inArray(responses.responseType, ['reply', 'rejection', 'meeting_request', 'bounce'])))
  return {
    sent: sentRow?.n ?? 0,
    replies: replyRow?.replies ?? 0,
    positive: replyRow?.positive ?? 0,
    bounces: replyRow?.bounces ?? 0,
  }
}

export async function runJournal(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  cycle: CycleDigest | null,
  progress: ProgressFn = noProgress,
): Promise<ServiceResult<JournalResult>> {
  const settings = await getProjectSettings(db, tenantId, projectId, null)
  if (!settings.ok) return settings
  if (!settings.value.publicScoreboardEnabled) {
    return ok({ kind: 'journal', summary: 'Public scoreboard is off; no journal entry.', saved: false })
  }
  await progress('composing', 0, 1)
  const today = utcDateKey()
  const since = new Date(`${today}T00:00:00Z`)
  const [counts, rejections] = await Promise.all([
    todayCounts(db, tenantId, projectId, since),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, { windowDays: 1, scope: 'all', freeTextLimit: 20, recontactLimit: 20, notRelevantLimit: 50 }),
  ])
  const reasons = rejections.ok ? rejections.value.primaryReasonDistribution.map((r) => `${r.reason} ×${r.count}`).join(', ') : ''
  const language = languageNameOf(settings.value.targetLanguage)

  const compose = async (objection: string | null) =>
    callGeminiJson({
      apiKey: env.GEMINI_API_KEY,
      model: HOSTED_MODEL,
      prompt: `You are Ace writing today's public journal entry (first person, ${language}) for a live page anyone can read. Today is ${today}.

Counts today: ${counts.sent} emails sent, ${counts.replies} replies (${counts.positive} positive), ${counts.bounces} bounces.
Why they said no (last 24h): ${reasons || 'no rejections in the last 24h'}.
This cycle's stage summaries: ${cycle ? JSON.stringify(cycle.stages) : '(none recorded)'}
Autonomous decisions this cycle: ${cycle && cycle.decisions.length > 0 ? cycle.decisions.join('; ') : 'none'}
${objection ? `\nThe previous attempt was rejected by the anonymization check: ${objection}. Rewrite without the offending item.` : ''}

Use exactly this shape and nothing more:
**${today}**

- This cycle: N emails sent · N replies (N positive) · N bounces
- Why they said no (last 24h): reason ×N, reason ×N   (or "no rejections in the last 24h")
- What I learned: one sentence
- What I got wrong: one concrete miss (never "nothing")

**Ace**

Rules: numbers exactly as given; anonymize every third party (companies → industry + size, people → role; no emails, domains, URLs, handles); only Ace and the product being sold stay named; never quote or paraphrase a prospect's message; a line with no data says so; never invent.`,
      schema: entrySchema,
      thinking: 'LOW',
      maxOutputTokens: 4096,
    })

  let entry: string
  try {
    entry = (await compose(null)).entry
  } catch (e) {
    if (e instanceof GeminiError) return ok({ kind: 'journal', summary: `Journal not written: ${e.message}`, saved: false })
    throw e
  }
  let saved = await runWithRls(db, tenantId, (tx) => saveDocument(tx, tenantId, STAGE_CALLER, env, { id: projectId, slug: 'public_journal' }, { content: entry }))
  if (!saved.ok && saved.code === 'UNPROCESSABLE') {
    try {
      entry = (await compose(typeof saved.detail === 'string' ? saved.detail : saved.error)).entry
      saved = await runWithRls(db, tenantId, (tx) => saveDocument(tx, tenantId, STAGE_CALLER, env, { id: projectId, slug: 'public_journal' }, { content: entry }))
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e
    }
  }
  return ok(
    saved.ok
      ? { kind: 'journal', summary: 'Public journal entry saved.', saved: true }
      : { kind: 'journal', summary: `Journal entry not saved: ${saved.error}. The previous entry stays on /live.`, saved: false },
  )
}
