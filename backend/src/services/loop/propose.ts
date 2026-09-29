// Stage: evaluate — the PDCA read of a project (evaluate/SKILL.md, server-side).
// The model narrates and proposes; every write passes a code gate first: no
// data → report only (a retraction still lands — withdrawn metrics are retired
// whatever the model returns), a fresh angle only when the tick asks for one,
// strategy registrations only when the portfolio is short.
import { z } from 'zod'
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { discoveryStrategySchema, variantIdSchema } from '../../domain/ids'
import { keepNewestRetired, retireWithdrawnMetricEntries, stampNewRetirements } from '../../domain/loop/learnings'
import type { JobResult } from '../../domain/jobs'
import { ok, err, type ServiceResult } from '../result'
import { callLlmJson, LlmError } from '../llm'
import { getProposeEvidence, type Archival, type AxisBucket, type ProposeEvidence, type ReactionCounts } from './observe'
import { loadLeverConfig } from '../project-settings'
import { getRejectionFeedbackSummaryById } from '../responses'
import { getLeverStateById, type LeverStateView } from './policy'
import { listMessageVariantsById, upsertMessageVariant } from '../message-variants'
import { upsertDiscoveryStrategy } from '../discovery-strategies'
import { recordSuggestion, ADD_MEANS_SUGGESTION_KIND, REVISIT_STRATEGY_SUGGESTION_KIND } from '../suggestions'
import { saveDocument } from '../documents'
import { loadDoc, loadMasterDoc, noProgress, requireStrategyDocs, STAGE_CALLER, type HostedEnv, type ProgressFn } from '../pipeline/context'
import { utcDateKey } from '../../domain/time'
import { runWithRls } from '../../db/rls'
import { draftReviewSection } from '../../domain/draft-review'
import { getDraftReviewFeedback } from '../draft-reviews'

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
      instruction: z.string().min(1).max(500),
    }),
  ),
})

export type EvaluateResult = Extract<JobResult, { kind: 'evaluate' }>

const RETIRED_KEPT = 10

const pct = (count: number, n: number): string => `${n === 0 ? 0 : Math.round((count / n) * 1000) / 10}%`
const counted = (c: ReactionCounts): string =>
  `n=${c.n} · positive ${c.positive} (${pct(c.positive, c.n)}) · interested ${c.interested} (${pct(c.interested, c.n)})`
const weighed = (weight: number | undefined, pBest: number | undefined): string =>
  `w=${weight?.toFixed(2) ?? '-'} p=${pBest?.toFixed(2) ?? '-'}`
const status = (o: { addedOn: string; archived: Archival | null }, active: string): string =>
  o.archived === null ? `active since ${o.addedOn} ${active}` : `archived ${o.archived.on} (${o.archived.reason})`
const axis = (buckets: AxisBucket[]): string => buckets.map((b) => `${b.value ?? '(none)'} ${counted(b)}`).join('; ') || 'none'

function measuredData(e: ProposeEvidence, lever: LeverStateView): string {
  const decision = lever.todaysDecision
  return [
    `KPI: ${counted(e.kpi)}`,
    'Message variants:',
    ...e.variants.map((v) =>
      `- ${v.variantId} ${JSON.stringify(v.label)} ${status(v, weighed(lever.weights?.[v.variantId], decision?.subject.pBest?.[v.variantId]))} · ${counted(v)} · subject ${JSON.stringify(v.subjectPattern)} · approach ${JSON.stringify(v.bodyApproach)}`),
    'Discovery strategies:',
    ...e.strategies.map((st) =>
      `- ${st.slug} ${status(st, weighed(lever.discovery.weights?.[st.slug], decision?.discovery?.pBest[st.slug]))} · ${counted(st)} · bounced ${st.bounced}/${st.bounceEligible} · approach ${JSON.stringify(st.approach)}`),
    ...Object.entries(e.axes).map(([name, buckets]) => `${name}: ${axis(buckets)}`),
    `Inquiry page: ${Object.entries(e.inquiryOutcomes).map(([o, n]) => `${o} ${n}`).join(' · ')}`,
    `Today's tick: vitals ${decision?.vitals?.verdict ?? 'not run'}`,
  ].join('\n')
}

function repliedSends(e: ProposeEvidence): string {
  return e.repliedSends
    .map((r) => [
      `- ${r.lastReplyOn} ${r.level} · variant ${r.variantId ?? '-'} · strategy ${r.strategy ?? '-'} · subject ${JSON.stringify(r.subject)}`,
      ...(r.ours === null ? [] : [`  ours: ${JSON.stringify(r.ours)}`]),
      `  theirs: ${JSON.stringify(r.theirs)}`,
    ].join('\n'))
    .join('\n') || '(none yet)'
}

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
  const config = await loadLeverConfig(db, projectId)
  const [evidence, rejections, lever, variants, learnings, frameworks, reviews] = await Promise.all([
    getProposeEvidence(db, projectId, config),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      windowDays: 30,
      scope: 'tactical',
      freeTextLimit: 20,
      recontactLimit: 20,
      notRelevantLimit: 50,
    }),
    getLeverStateById(db, tenantId, projectId),
    listMessageVariantsById(db, tenantId, projectId),
    loadDoc(db, tenantId, projectId, 'learnings'),
    loadMasterDoc(db, 'tpl_analysis_frameworks'),
    getDraftReviewFeedback(db, tenantId, projectId, 'evaluate'),
  ])
  if (!lever.ok) return lever
  if (!variants.ok) return variants
  const { sufficient } = evidence
  const rejectionData = rejections.ok ? rejections.value : null
  const tidy = (log: string): string =>
    keepNewestRetired(stampNewRetirements(learnings, retireWithdrawnMetricEntries(log), utcDateKey()), RETIRED_KEPT)
  const priorLearnings = learnings === null ? null : tidy(learnings)

  await progress('analyzing', 1, 3)
  const prompt = `You are Ace, evaluating a project's outbound results and steering the next cycle. Today is ${utcDateKey()}.

## Business
${docs.value.business}

## Strategy
${docs.value.salesStrategy}

## Learnings Log (one line per entry: "[stage] [YYYY-MM-DD] claim — evidence: metric=<name>, n=<sample>"; "[retired]" tombstones stay)
${priorLearnings ?? '(none yet)'}

## Analysis frameworks
${frameworks}

## Measured data (sends since ${evidence.frameStart ?? 'the first send'}; n = sends older than ${config.rewardWindowDays} days; positive = a meeting request, positive reply or signup; interested adds neutral replies and chats; w / p = today's weight and P(best))
${measuredData(evidence, lever.value)}
rejection feedback (30 days, tactical): ${rejectionData ? JSON.stringify(rejectionData) : '(unavailable this run)'}

## Replied sends (newest first; ours = our message, where they showed interest)
${repliedSends(evidence)}

## Draft review (what the person rewrote or threw out before sending)
${draftReviewSection(reviews) ?? '(nothing corrected)'}

## Rules
- KPI: the positive rate; interested is weaker, for when positives are too few.
- Data sufficient is ${sufficient} (${evidence.settled} settled sends). When false: report only — learnings, salesStrategy and newVariant must be null, strategyUpserts and suggestions empty (except a strategy that no longer exists or cannot select for the Prerequisites, which may be archived).
- Stability: change only on patterns repeated across cycles; if the last change cannot be measured yet, change nothing more.
- salesStrategy: return the full document with only Target (Primary / Secondary / Prerequisites / Not a fit), KPI and Search Keywords changed, or null. Adjust within the frame; never write a frame change (offer, market, industry, country, channel — past sends no longer apply). Judge Target as a premise (can they use and buy it?) before the positive rate. A wrong-prospect call in Draft review tells you the Target: when it names a kind of organization, reflect it in "Not a fit".
- learnings: return the full log with reconciled entries, or null. Write gate for a new entry: a cited metric with n ≥ ${lever.value.minSamplePerArm}, a pattern that repeated. Retire entries whose direction no longer reproduces by replacing their tag with [retired]. Keep ≤ 15 active entries. Draft review carries no metric, so it never becomes an entry. Stage tags: [targeting] [body] [timing] [channel] [discovery].
- newVariant: only when today's tick asks for one (${lever.value.needsReplenishment}) — one angle most different from every listed one (subject pattern ≤ 80 chars using only {{org}} / {{name}} / {{signal}} placeholders, a 2–5 line body approach, a label) on a fresh slug like gen_${utcDateKey().replace(/-/g, '')}; otherwise null.
- strategyUpserts: archive (archived: true, approach echoed unchanged) only on evidence the tick cannot see — clearly elevated bounces, an approach that cannot select for the Prerequisites, or a dead source. Register 1–2 fresh strategies (new kebab-case slug, 2–5 line approach: where / how to search and why it should work, preferring sources where the Prerequisites are observable) only when new strategies are needed (${lever.value.discovery.needsReplenishment}) or the premise check reoriented the Target. Never reuse a slug for a different idea.
- suggestions: only actions the person alone can do — kind "${ADD_MEANS_SUGGESTION_KIND}" for a means needing account setup (dedupeKey = the tentative strategy slug), kind "${REVISIT_STRATEGY_SUGGESTION_KIND}" (dedupeKey e.g. cross-channel-slump) when low performance persists across every channel and strategy through repeated rotations, or for a frame change. instruction = the next action as one sentence addressed to Ace.
- report (markdown): key KPIs; inquiry-landing conversions when any outcome is non-zero; changes since the last cycle; discovery strategy performance (skip when no send carries a slug); suggestions recorded; findings; improvements applied; tactical rejection signals (distribution, recontact queue, decision-maker referrals) when total > 0; lever observability (leading options with w / p and maturity at n ≥ ${lever.value.minSamplePerArm}, archived options — "rotated" is for freshness, not a loser; "none yet" without data); next actions. Never imply progress the numbers do not show.`

  let out: z.infer<typeof evaluationSchema>
  try {
    out = await callLlmJson(env, 'evaluate', { prompt, schema: evaluationSchema })
  } catch (e) {
    if (e instanceof LlmError) return err('BAD_GATEWAY', 'Evaluation failed upstream', e.message)
    throw e
  }

  await progress('applying', 2, 3)
  const wrote: string[] = []
  const proposedLearnings = sufficient ? out.learnings : null
  const nextLearnings = proposedLearnings === null ? priorLearnings : tidy(proposedLearnings)
  if (nextLearnings !== null && nextLearnings !== learnings) {
    const r = await runWithRls(db, tenantId, (tx) => saveDocument(tx, tenantId, STAGE_CALLER, env, { id: projectId, slug: 'learnings' }, { content: nextLearnings }))
    if (r.ok) wrote.push(proposedLearnings === null ? 'learnings (retired entries tidied)' : 'learnings')
  }
  if (sufficient) {
    const { salesStrategy: newStrategy, newVariant } = out
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
