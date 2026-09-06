// Stage: evaluate — the PDCA read of a project (evaluate/SKILL.md, server-side).
// The model narrates and proposes; every write passes a code gate first: no
// data → report only, a fresh angle only when the tick asks for one, strategy
// registrations only when the portfolio is short.
import { z } from 'zod'
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { discoveryStrategySchema, variantIdSchema } from '../../domain/ids'
import type { JobResult } from '../../domain/jobs'
import { ok, err, type ServiceResult } from '../result'
import { callGeminiJson, GeminiError, HOSTED_MODEL } from '../gemini'
import { getProjectStats } from '../evaluations'
import { getRejectionFeedbackSummaryById } from '../responses'
import { getLeverDecisionsHistory, getLeverStateById } from '../levers'
import { listMessageVariantsById, upsertMessageVariant } from '../message-variants'
import { upsertDiscoveryStrategy } from '../discovery-strategies'
import { recordSuggestion, ADD_MEANS_SUGGESTION_KIND, REVISIT_STRATEGY_SUGGESTION_KIND } from '../suggestions'
import { saveDocument } from '../documents'
import { loadDoc, loadMasterDoc, noProgress, requireStrategyDocs, STAGE_CALLER, type HostedEnv, type ProgressFn } from './context'
import { utcDateKey } from '../../domain/time'
import { runWithRls } from '../../db/rls'

const evaluationSchema = z.object({
  // The narration a person reads (markdown): KPIs, findings, lever
  // observability, tactical rejection signals, next actions.
  report: z.string().min(1),
  // Full replacement documents, or null to leave them unchanged.
  learnings: z.string().nullable(),
  salesStrategy: z.string().nullable(),
  newVariant: z
    .object({
      variantId: variantIdSchema,
      subjectPattern: z.string().min(1).max(80),
      bodyApproach: z.string().min(1).max(2000),
      label: z.string().min(1).max(120),
    })
    .nullable(),
  strategyUpserts: z.array(
    z.object({ slug: discoveryStrategySchema, approach: z.string().min(1).max(2000), archived: z.boolean() }),
  ),
  suggestions: z.array(
    z.object({
      kind: z.enum([ADD_MEANS_SUGGESTION_KIND, REVISIT_STRATEGY_SUGGESTION_KIND]),
      dedupeKey: z.string().min(1).max(128),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(4000),
      // A sentence the person can paste into the LeadAce chat.
      command: z.string().min(1).max(500),
    }),
  ),
})

export type EvaluateResult = Extract<JobResult, { kind: 'evaluate' }>

export async function runEvaluate(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  progress: ProgressFn = noProgress,
): Promise<ServiceResult<EvaluateResult>> {
  const docs = await requireStrategyDocs(db, tenantId, projectId)
  if (!docs.ok) return docs
  await progress('collecting data', 0, 3)
  const [stats, rejections, lever, history, variants, learnings, frameworks] = await Promise.all([
    getProjectStats(db, tenantId, projectId),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      windowDays: 30,
      scope: 'tactical',
      freeTextLimit: 20,
      recontactLimit: 20,
      notRelevantLimit: 50,
    }),
    getLeverStateById(db, tenantId, projectId),
    getLeverDecisionsHistory(db, tenantId, projectId, 14),
    listMessageVariantsById(db, tenantId, projectId),
    loadDoc(db, tenantId, projectId, 'learnings'),
    loadMasterDoc(db, 'tpl_analysis_frameworks'),
  ])
  if (!stats.ok) return stats
  if (!lever.ok) return lever
  if (!variants.ok) return variants
  const sufficient = stats.value.dataSufficiency.sufficient
  const rejectionData = rejections.ok ? rejections.value : null

  await progress('analyzing', 1, 3)
  const prompt = `You are Ace, evaluating a project's outbound results and steering the next cycle. Today is ${utcDateKey()}.

## Business
${docs.value.business}

## Strategy (Target / KPI / Search Keywords are yours to update; Messaging and Sales Channels are the person's hints and the lever's domain — never rewrite them)
${docs.value.salesStrategy}

## Learnings Log (the cross-stage memory; one line per entry: "[stage] [YYYY-MM-DD] claim — evidence: metric=<name>, n=<sample>"; "[retired]" tombstones stay)
${learnings ?? '(none yet)'}

## Analysis frameworks
${frameworks}

## Measured data
get_eval_data: ${JSON.stringify(stats.value)}
rejection feedback (30 days, tactical): ${rejectionData ? JSON.stringify(rejectionData) : '(unavailable this run)'}
lever state: ${JSON.stringify(lever.value)}
lever decisions (14 days, newest first): ${history.ok ? JSON.stringify(history.value.decisions) : '[]'}
message variants: ${JSON.stringify(variants.value.variants)}

## Rules
- dataSufficiency.sufficient is ${sufficient}. When false: report only — learnings, salesStrategy and newVariant must be null, strategyUpserts and suggestions empty (except a strategy that no longer exists or cannot select for the Prerequisites, which may be archived).
- Stability: change strategy only on patterns that repeated across cycles, never on one-off fluctuations; if the last change cannot be measured yet, change nothing more.
- salesStrategy: return the full document with only Target (Primary / Secondary / Prerequisites / Not a fit), KPI and Search Keywords changed, or null. Judge Target as a premise (can they use and buy it?) before reply rate.
- learnings: return the full log with reconciled entries, or null. Write gate for a new entry: sufficient data, a cited metric with n ≥ ${lever.value.minSamplePerArm}, a pattern that repeated. Retire entries whose direction no longer reproduces by replacing their tag with [retired]. Keep ≤ 15 active entries. Stage tags: [targeting] [body] [timing] [channel] [discovery].
- newVariant: only when lever needsReplenishment is ${lever.value.needsReplenishment} === true — one angle most different from every active one (subject pattern ≤ 80 chars using only {{org}} / {{name}} / {{signal}} placeholders, a 2–5 line body approach, a label) on a fresh slug like gen_${utcDateKey().replace(/-/g, '')}; otherwise null.
- strategyUpserts: archive (archived: true, approach echoed unchanged) only on evidence the tick cannot see — clearly elevated bounceRate, an approach that cannot select for the Prerequisites, or a dead source. Register 1–2 fresh strategies (new kebab-case slug, 2–5 line approach: where / how to search and why it should work, preferring sources where the Prerequisites are observable) only when discovery.needsReplenishment is ${lever.value.discovery.needsReplenishment} === true or the premise check reoriented the Target. Never reuse a slug for a different idea.
- suggestions: only actions the person alone can do — kind "${ADD_MEANS_SUGGESTION_KIND}" for a means needing account setup (dedupeKey = the tentative strategy slug), kind "${REVISIT_STRATEGY_SUGGESTION_KIND}" (dedupeKey e.g. cross-channel-slump) when low performance persists across every channel and strategy through repeated rotations. command = a sentence to paste into the LeadAce chat.
- report (markdown): key KPIs; inquiry-landing conversions when any outcome is non-zero; changes since the last cycle; discovery strategy performance (skip when no send carries a slug); suggestions recorded; findings; improvements applied; tactical rejection signals (distribution, recontact queue, decision-maker referrals) when total > 0; lever observability (angles leading with weights / pBest and maturity vs minSamplePerArm, archived variants — a "stagnation" archive is a rotation for freshness, not a loser — channel affinity, targeting lifts, trend across ticks; "uniform / none yet" when there is no data); next actions. Never imply progress the numbers do not show.`

  let out: z.infer<typeof evaluationSchema>
  try {
    out = await callGeminiJson({
      apiKey: env.GEMINI_API_KEY,
      model: HOSTED_MODEL,
      prompt,
      schema: evaluationSchema,
      maxOutputTokens: 16384,
    })
  } catch (e) {
    if (e instanceof GeminiError) return err('BAD_GATEWAY', 'Evaluation failed upstream', e.message)
    throw e
  }

  await progress('applying', 2, 3)
  const wrote: string[] = []
  if (sufficient) {
    const { learnings: newLearnings, salesStrategy: newStrategy, newVariant } = out
    if (newLearnings !== null && newLearnings !== learnings) {
      const r = await runWithRls(db, tenantId, (tx) => saveDocument(tx, tenantId, STAGE_CALLER, env, { id: projectId, slug: 'learnings' }, { content: newLearnings }))
      if (r.ok) wrote.push('learnings')
    }
    if (newStrategy !== null && newStrategy !== docs.value.salesStrategy) {
      const r = await runWithRls(db, tenantId, (tx) => saveDocument(tx, tenantId, STAGE_CALLER, env, { id: projectId, slug: 'sales_strategy' }, { content: newStrategy }))
      if (r.ok) wrote.push('sales_strategy')
    }
    if (newVariant && lever.value.needsReplenishment && !variants.value.variants.some((v) => v.variantId === newVariant.variantId)) {
      const r = await runWithRls(db, tenantId, (tx) => upsertMessageVariant(tx, tenantId, projectId, newVariant))
      if (r.ok) wrote.push(`variant ${newVariant.variantId}`)
    }
    for (const s of out.suggestions) {
      const r = await runWithRls(db, tenantId, (tx) => recordSuggestion(tx, tenantId, projectId, s))
      if (r.ok && r.value.written) wrote.push(`suggestion ${s.kind}/${s.dedupeKey}`)
    }
  }
  const known = new Set(lever.value.discovery.strategies.map((s) => s.slug))
  for (const u of out.strategyUpserts) {
    const isNew = !known.has(u.slug)
    if (isNew && (!sufficient || !lever.value.discovery.needsReplenishment)) continue
    if (!isNew && !u.archived) continue
    const r = await runWithRls(db, tenantId, (tx) => upsertDiscoveryStrategy(tx, tenantId, projectId, u))
    if (r.ok) wrote.push(`${u.archived ? 'archived' : 'registered'} strategy ${u.slug}`)
  }

  const firstLine = out.report.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? 'Report ready.'
  return ok({
    kind: 'evaluate',
    summary: `${sufficient ? firstLine : 'Insufficient data — report only.'}${wrote.length > 0 ? ` Wrote: ${wrote.join(', ')}.` : ''}`,
    report: out.report,
    wrote,
  })
}
