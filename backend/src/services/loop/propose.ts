// Stage: evaluate — the PDCA read of a project (evaluate/SKILL.md, server-side).
// The model narrates and proposes; writes pass code gates first: too few settled
// sends → no sales strategy or variant change, a fresh angle only into a slot the
// tick freed or in place of a variant out of its grace that is not the leader,
// active strategies never above the cap, and a limit the person set only
// loosened through a proposal they can stop.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { projects } from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { discoveryStrategySchema, variantIdSchema } from '../../domain/ids'
import type { JobResult } from '../../domain/jobs'
import { ok, err, type ServiceResult } from '../result'
import { callLlmJson, LlmError } from '../llm'
import { DISCOVERY_WINDOW_DAYS, frameHistory, getProposeEvidence, type AxisBucket, type ProposeEvidence, type StrategyDiscovery } from './observe'
import type { Evidence } from '../../domain/loop/evidence'
import { applySalesStrategyEdit, frameStart, listChanges, loadReach, type OptionArchival } from './change'
import { recentProposals, recordAddMeans, recordFrame, recordLoosening, type ProposalRow } from './proposals'
import { authorOf, changeReasonSchema, changeSignalsSchema, channelList, countryList, reachLine, type LoggedChange, type OptionOp } from '../../domain/loop/change'
import { frameBodySchema, proposalWhat, type ProposedChange } from '../../domain/loop/proposal'
import { FRAME_SIGNAL, type FramePeriod } from '../../domain/loop/frame'
import { replaceableArms } from '../../domain/loop/options'
import { OUTBOUND_CHANNELS } from '../../domain/outbound-channel'
import { ALLOWED_SEND_COUNTRIES } from '../../domain/country'
import { getOutboundMode, loadLeverConfig } from '../project-settings'
import { getRejectionFeedbackSummaryById } from '../responses'
import { getLeverStateById, type LeverStateView } from './policy'
import { listMessageVariantsById, replaceMessageVariant, upsertMessageVariant } from '../message-variants'
import { upsertDiscoveryStrategy } from '../discovery-strategies'
import { notify, notifyCtxOf } from '../notifications'
import { loadMasterDoc, noProgress, requireStrategyDocs, STAGE_CALLER, type HostedEnv, type ProgressFn } from '../pipeline/context'
import { utcDateKey } from '../../domain/time'
import { runWithRls } from '../../db/rls'
import { draftReviewSection } from '../../domain/draft-review'
import { applySectionEdits, sectionEditSchemaFor } from '../../domain/document-sections'
import { getDraftReviewFeedback } from '../draft-reviews'

const evaluationSchemaFor = (salesStrategy: string) => z.object({
  // The narration a person reads (markdown): KPIs, findings, lever
  // observability, tactical rejection signals, next actions.
  report: z.string().min(1),
  salesStrategy: sectionEditSchemaFor(salesStrategy).extend({ content: z.string().min(1), why: changeReasonSchema, signals: changeSignalsSchema }).nullable(),
  newVariant: z
    .object({
      variantId: variantIdSchema,
      subjectPattern: z.string().min(1).max(80),
      bodyApproach: z.string().min(1).max(2000),
      label: z.string().min(1).max(120),
      replaces: variantIdSchema.nullable(),
      why: changeReasonSchema,
      signals: changeSignalsSchema,
    })
    .nullable(),
  loosen: z
    .object({
      outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).nullable(),
      targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).nullable(),
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(2000),
      why: changeReasonSchema,
    })
    .nullable(),
  strategyUpserts: z.array(
    z.object({ slug: discoveryStrategySchema, approach: z.string().min(1).max(2000), archived: z.boolean(), why: changeReasonSchema, signals: changeSignalsSchema }),
  ),
  addMeans: z.array(
    z.object({
      strategy: discoveryStrategySchema,
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(4000),
      instruction: z.string().min(1).max(500),
    }),
  ),
})

export type EvaluateResult = Extract<JobResult, { kind: 'evaluate' }>

const CHANGE_LOG_DAYS = 30

const pct = (count: number, n: number): string => `${n === 0 ? 0 : Math.round((count / n) * 1000) / 10}%`
const declined = (c: Evidence): string => {
  const reasons = Object.entries(c.reasons).map(([reason, n]) => `${reason} ${n}`).join(', ')
  return `declined ${c.declined}${reasons === '' ? '' : ` (${reasons})`}`
}
const counted = (c: Evidence): string =>
  `n=${c.trials.toFixed(1)} · positive ${c.positive} (${pct(c.positive, c.trials)}) · interested ${c.interested} (${pct(c.interested, c.trials)}) · ${declined(c)}`
const weighed = (weight: number | undefined, pBest: number | undefined): string =>
  `w=${weight?.toFixed(2) ?? '-'} p=${pBest?.toFixed(2) ?? '-'}`
const BY = { ace: 'by you', user: 'by the person' } as const
const why = (reason: string | null): string => (reason ? `: ${JSON.stringify(reason)}` : '')
const archivedWhy = (a: OptionArchival): string =>
  a.actor === null ? '' : a.actor === 'rule' ? ` (${a.reason})` : ` ${BY[a.actor]}${why(a.reason)}`
const status = (o: { addedOn: string; archived: OptionArchival | null }, active: string): string =>
  o.archived === null ? `active since ${o.addedOn} ${active}` : `archived ${o.archived.day}${archivedWhy(o.archived)}`
const offBy = (d: StrategyDiscovery): string => {
  const counts = Object.entries(d.channelsOffBy).filter(([, n]) => n > 0).map(([channel, n]) => `${channel} ${n}`)
  return counts.length === 0 ? '' : ` (${counts.join(', ')})`
}
const explored = (d: StrategyDiscovery): string =>
  `explored ${d.passes} passes: asked ${d.asked}, returned ${d.returned}, new ${d.fresh}; registered ${d.registered} (not targeted ${d.unqualified}; in the Target: sendable ${d.sendable}, contact only on a channel that is off ${d.channelsOff}${offBy(d)}, contact on file but unusable ${d.registered - d.unqualified - d.sendable - d.channelsOff - d.noContact}, no contact found ${d.noContact})`
const perSendable = ({ usd, sendable }: ProposeEvidence['discoveryCost']): string =>
  `$${usd.toFixed(2)}${sendable === 0 ? '' : ` ($${(usd / sendable).toFixed(3)} per sendable prospect registered)`}`
const axis = (buckets: AxisBucket[]): string => buckets.map((b) => `${b.value ?? '(none)'} ${counted(b)}`).join('; ') || 'none'

function measuredData(e: ProposeEvidence, lever: LeverStateView, targetCountries: string[]): string {
  const decision = lever.todaysDecision
  return [
    `KPI: ${counted(e.kpi)}`,
    'Message variants:',
    ...e.variants.map((v) =>
      `- ${v.variantId} ${JSON.stringify(v.label)} ${status(v, weighed(lever.weights?.[v.variantId], decision?.subject.pBest?.[v.variantId]))} · ${counted(v)} · subject ${JSON.stringify(v.subjectPattern)} · approach ${JSON.stringify(v.bodyApproach)}`),
    `Channels on: ${channelList(e.channels)} (the person's setting; hosted sends email itself, a form or SNS message waits for the person to send it)`,
    `Countries: ${countryList(targetCountries)} (the person's setting)`,
    `Hosted discovery cost, last ${DISCOVERY_WINDOW_DAYS} days: ${perSendable(e.discoveryCost)}`,
    'Discovery strategies:',
    ...e.strategies.map((st) =>
      `- ${st.slug} ${status(st, weighed(lever.discovery.weights?.[st.slug], decision?.discovery?.pBest[st.slug]))} · ${counted(st)} · bounced ${st.bounced}/${st.bounceable} · ${explored(st.discovery)} · approach ${JSON.stringify(st.approach)}`),
    ...Object.entries(e.axes).map(([name, buckets]) => `${name}: ${axis(buckets)}`),
    `Inquiry page: ${Object.entries(e.inquiryOutcomes).map(([o, n]) => `${o} ${n}`).join(' · ')}`,
    `Today's tick: vitals ${decision?.vitals?.verdict ?? 'not run'}`,
  ].join('\n')
}

const DONE: Record<OptionOp, string> = { add: 'added', update: 'edited', archive: 'archived', restore: 'restored' }

function changeLine(c: LoggedChange): string {
  if (c.actor === 'rule') return `- ${c.day} ${c.target} ${c.optionId} ${DONE[c.op]} by the tick${c.op === 'archive' ? ` (${c.reason})` : ''}`
  if ('optionId' in c) return `- ${c.day} ${c.target} ${c.optionId} ${DONE[c.op]} ${BY[c.actor]}${why(c.reason)}`
  if (c.target === 'settings') return `- ${c.day} settings changed ${BY[c.actor]}: ${reachLine(c.diff)}${why(c.reason)}`
  if (c.target === 'frame') return `- ${c.day} a new frame started ${BY[c.actor]}${why(c.reason)}`
  return `- ${c.day} ${c.target} edited ${BY[c.actor]}${why(c.reason)}`
}

function proposalState({ status, change }: ProposalRow): string {
  switch (status) {
    case 'pending':
      return change.kind === 'loosen' ? `pending, applies ${change.applyOn}` : 'waiting for the person to set it up'
    case 'applied':
      return 'applied'
    case 'stopped':
      return 'stopped by the person'
    case 'outdated':
      return 'dropped: the settings changed before it applied'
  }
}

const proposalLine = (p: ProposalRow): string =>
  `- ${p.createdAt.toISOString().slice(0, 10)} ${JSON.stringify(p.title)}: ${proposalWhat(p.change)} — ${proposalState(p)}`

function repliedSends(e: ProposeEvidence): string {
  return e.repliedSends
    .map((r) => [
      `- ${r.lastReplyOn} ${r.level} · variant ${r.variantId ?? '-'} · strategy ${r.strategy ?? '-'} · subject ${JSON.stringify(r.subject)}`,
      ...(r.ours === null ? [] : [`  ours: ${JSON.stringify(r.ours)}`]),
      `  theirs: ${JSON.stringify(r.theirs)}`,
    ].join('\n'))
    .join('\n') || '(none yet)'
}

type PendingLoosen = ProposalRow & { change: Extract<ProposedChange, { kind: 'loosen' }> }
type PendingFrame = ProposalRow & { change: Extract<ProposedChange, { kind: 'frame' }> }
type Announced = { id: number; applyOn: string; title: string; body: string }

// The person has one day to stop it, so it is announced the day it is made.
// Every run announces the pending one: the reference files it once, and a run
// that died between recording it and announcing it is made up for by the
// rerun. A notice that could not go out must not undo the proposal: the
// dashboard shows it.
async function announceProposal(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  p: Announced,
): Promise<void> {
  const run = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => runWithRls(db, tenantId, fn)
  try {
    const [project] = await run((tx) => tx.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1))
    const sent = await notify(run, tenantId, notifyCtxOf(env), {
      category: 'insight',
      reference: `proposal:${p.id}`,
      subject: `${project?.name ?? 'Your project'}: ${p.title} on ${p.applyOn} unless you stop it`,
      body: `${p.body}\n\nAce makes this change in the first cycle on or after ${p.applyOn} (UTC). On the dashboard you can apply it now, stop it, or tell Ace what to do instead.`,
      link: '/dashboard',
    })
    if (!sent.ok) console.warn(`[evaluate] proposal ${p.id} notice failed: ${sent.error}`)
  } catch (e) {
    console.warn(`[evaluate] proposal ${p.id} notice failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// What both judges read: the frame's measured data and what was already
// changed or proposed.
async function gather(db: Db, tenantId: TenantId, projectId: ProjectId) {
  const docs = await requireStrategyDocs(db, tenantId, projectId)
  if (!docs.ok) return docs
  const [config, start] = await Promise.all([loadLeverConfig(db, projectId), frameStart(db, projectId)])
  const since = new Date(Date.now() - CHANGE_LOG_DAYS * 24 * 60 * 60 * 1000)
  const [evidence, rejections, lever, reviews, changes, proposals, reach] = await Promise.all([
    getProposeEvidence(db, projectId, config),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      windowDays: 30,
      scope: 'tactical',
      freeTextLimit: 20,
      recontactLimit: 20,
      notRelevantLimit: 50,
    }, start),
    getLeverStateById(db, tenantId, projectId),
    getDraftReviewFeedback(db, tenantId, projectId, 'evaluate'),
    listChanges(db, projectId, since),
    recentProposals(db, projectId, since),
    loadReach(db, projectId),
  ])
  if (!lever.ok) return lever
  return ok({ docs: docs.value, config, evidence, rejections: rejections.ok ? rejections.value : null, lever: lever.value, reviews, changes, proposals, reach })
}

type Judged = Extract<Awaited<ReturnType<typeof gather>>, { ok: true }>['value']

function measuredSections({ config, evidence, rejections, lever, reviews, changes, proposals, reach }: Judged): string {
  return `## Measured data (sends since ${evidence.frameStart ?? 'the first send'}; n = trials, as the tick counts them: a send that drew a reply counts 1 when the reply arrives, a silent one by its age (0.5 at 6 hours, 0.9 at 6 days, 1 from 14 days), a bounced one 0${config.rewardLookbackDays === undefined ? '' : `; the variant and strategy lines count only sends from the last ${config.rewardLookbackDays} days`}; positive = a meeting request, positive reply or signup; interested adds neutral replies and chats; declined = a no, by its stated reason; w / p = today's weight and P(best); explored = the strategy's hosted discovery over the last ${DISCOVERY_WINDOW_DAYS} days — candidates asked for, returned and new after dedup, then, counted apart from those passes, every prospect registered under the strategy in that time (hosted or brought in))
${measuredData(evidence, lever, reach.targetCountries)}
rejection feedback (30 days, tactical): ${rejections ? JSON.stringify(rejections) : '(unavailable this run)'}

## Replied sends (newest first; ours = our message, where they showed interest)
${repliedSends(evidence)}

## Draft review (what the person rewrote or threw out before sending)
${draftReviewSection(reviews) ?? '(nothing corrected)'}

## Changes in the last ${CHANGE_LOG_DAYS} days (newest first: what is still being measured, and what was already tried)
${changes.map(changeLine).join('\n') || '(none)'}

## Proposals to the person in the last ${CHANGE_LOG_DAYS} days (newest first)
${proposals.map(proposalLine).join('\n') || '(none)'}`
}

export async function runEvaluate(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  progress: ProgressFn = noProgress,
): Promise<ServiceResult<EvaluateResult>> {
  await progress('collecting data', 0, 3)
  const [judged, variants, frameworks] = await Promise.all([
    gather(db, tenantId, projectId),
    listMessageVariantsById(db, tenantId, projectId),
    loadMasterDoc(db, 'tpl_analysis_frameworks'),
  ])
  if (!judged.ok) return judged
  if (!variants.ok) return variants
  const { docs, config, evidence, lever, proposals } = judged.value
  const activeStrategies = new Set(lever.discovery.strategies.filter((s) => s.archivedAt === null).map((s) => s.slug))
  const { sufficient } = evidence
  const replaceable = replaceableArms(
    evidence.variants.filter((v) => v.archived === null).map((v) => ({ armId: v.variantId, sinceEntry: v.sinceEntry })),
    lever.todaysDecision?.subject.pBest ?? {},
    config.minSamplePerArm,
  )
  const pendingLoosen = proposals.find((p): p is PendingLoosen => p.status === 'pending' && p.change.kind === 'loosen')
  // The sales strategy has one writer while the person decides on a new frame.
  const pendingFrame = proposals.find((p): p is PendingFrame => p.status === 'pending' && p.change.kind === 'frame')

  await progress('analyzing', 1, 3)
  const prompt = `You are Ace, evaluating a project's outbound results and steering the next cycle. Today is ${utcDateKey()}.

## Business
${docs.business}

## Strategy
${docs.salesStrategy}

## Analysis frameworks
${frameworks}

${measuredSections(judged.value)}

## Rules
- KPI: the positive rate; interested is weaker, for when positives are too few.
- Data sufficient is ${sufficient} (n=${evidence.kpi.trials.toFixed(1)}). When false: salesStrategy and newVariant must be null; strategyUpserts, loosen and addMeans that rest on discovery, not replies, still apply.
- Stability: change only on patterns repeated across cycles; leave a thing alone while its last change cannot be measured yet.
- A finding goes in as a change to what it is about, with the finding and its numbers as the why: who to reach → salesStrategy; where to search → strategyUpserts; what to say and how → newVariant; a limit the person set → loosen; a means that needs an account set up → addMeans.
- salesStrategy: the Target section (Primary / Secondary / Prerequisites / Not a fit) rewritten whole, its ## heading line first, with why and signals; every other section stays as it is. Or null. Adjust within the frame; never write a frame change (offer, market, industry, country, channel — past sends no longer apply). Judge Target as a premise (can they use and buy it?) before the positive rate. The noes say where it is off: not_decision_maker points at the role, not_relevant or already_have_solution gathered in one industry or size points at that segment. A wrong-prospect call in Draft review tells you the Target: when it names a kind of organization, reflect it in "Not a fit". null while a new frame is pending (${pendingFrame !== undefined}).
- newVariant: when today's tick asks for one (${lever.needsReplenishment}), into the free slot (replaces: null). Otherwise only when the replied sends show an angle no listed variant takes, in place of one of: ${replaceable.join(', ') || 'none today'} (replaces: its id; these are out of their grace and not today's likeliest best). One angle most different from every listed one: what it promises, how it opens, why now (subject pattern ≤ 80 chars using only {{org}} / {{name}} / {{signal}} placeholders, a 2–5 line body approach, a label, why: what in the replies points to it and how it differs from the listed ones) on a fresh slug like gen_${utcDateKey().replace(/-/g, '')}; otherwise null.
- strategyUpserts: the goal is up to ${config.targetActiveStrategies} active strategies (${activeStrategies.size} now), each still finding organizations in the Target with a usable contact. Judge strategies on their explored numbers and on the noes and bounces their sends drew; the tick already weighs positive rates. Archive one whose finds are mostly not targeted, with no contact found, not new, bouncing, or mostly answered not_relevant or already_have_solution (archived: true, approach echoed unchanged), and register its replacement in the same run. A new strategy takes a new kebab-case slug and a 2–5 line approach: where and how to search, and why it should work; prefer sources where the Prerequisites are observable. Never reuse a slug for a different idea. why: the evidence for an archive, the hypothesis for a new strategy.
- loosen: when a channel that is off or the country list keeps organizations in the Target from being reached, and the numbers show it is worth it: outboundChannels = the full list with the channel added, targetCountries = the full list with the country added or [] to lift the limit, null for the one left as it is; a title naming the change; a body with the numbers and what it means for the person (a form or SNS message waits for them to send it); why. It applies tomorrow unless the person stops it. null while one or a new frame is pending (${pendingLoosen !== undefined || pendingFrame !== undefined}). Never repeat one the person stopped.
- addMeans: a means that needs an account set up, when the numbers show it is worth it and it was never proposed: strategy = the tentative strategy slug; body: the numbers behind it and what it asks of the person; instruction = the next action as one sentence addressed to Ace.
- why: one short line, kept in the change log the person reads.
- signals: every kind of evidence a salesStrategy, newVariant or strategyUpserts change rests on: replies (positive and interested against silence), declines (the noes and their reasons), bounces, discovery (Target fit, contacts, channels, cost), person (Draft review).
- report (markdown): key KPIs; inquiry-landing conversions when any outcome is non-zero; changes since the last cycle; discovery strategy performance (skip when no send carries a slug); proposals recorded; findings; improvements applied; tactical rejection signals (distribution, recontact queue, decision-maker referrals) when total > 0; lever observability (leading options with w / p and maturity at n ≥ ${lever.minSamplePerArm}, archived options — "rotated" is for freshness, not a loser; "none yet" without data); next actions. Never imply progress the numbers do not show.`

  let out: z.infer<ReturnType<typeof evaluationSchemaFor>>
  try {
    out = await callLlmJson(env, 'evaluate', { prompt, schema: evaluationSchemaFor(docs.salesStrategy) })
  } catch (e) {
    if (e instanceof LlmError) return err('BAD_GATEWAY', 'Evaluation failed upstream', e.message)
    throw e
  }

  await progress('applying', 2, 3)
  const wrote: string[] = []
  if (sufficient) {
    const { salesStrategy: newStrategy, newVariant } = out
    if (newStrategy !== null && pendingFrame === undefined) {
      const { why, signals, ...edit } = newStrategy
      const edited = applySectionEdits(docs.salesStrategy, [edit])
      if (!edited.ok) console.warn(`[evaluate] sales strategy edit for ${projectId} not applied: ${edited.why}`)
      else if (edited.content !== docs.salesStrategy) {
        const written = await runWithRls(db, tenantId, (tx) =>
          applySalesStrategyEdit(tx, tenantId, projectId, edited.content, authorOf(STAGE_CALLER, why, signals), docs.salesStrategyId))
        if (written) wrote.push('sales_strategy')
      }
    }
    const outgoing = newVariant?.replaces && !lever.needsReplenishment && replaceable.includes(newVariant.replaces) ? newVariant.replaces : null
    if (newVariant && (lever.needsReplenishment || outgoing) && !variants.value.variants.some((v) => v.variantId === newVariant.variantId)) {
      const { why, signals, replaces: _, ...variant } = newVariant
      const body = { ...variant, reason: why }
      const r = await runWithRls(db, tenantId, (tx) =>
        outgoing
          ? replaceMessageVariant(tx, tenantId, STAGE_CALLER, projectId, outgoing, body, signals)
          : upsertMessageVariant(tx, tenantId, STAGE_CALLER, projectId, body, signals))
      if (r.ok) wrote.push(outgoing ? `variant ${variant.variantId} in place of ${outgoing}` : `variant ${variant.variantId}`)
    }
  }
  let announced: Announced | null = pendingLoosen
    ? { id: pendingLoosen.id, applyOn: pendingLoosen.change.applyOn, title: pendingLoosen.title, body: pendingLoosen.body }
    : null
  if (out.loosen && announced === null) {
    const { why, ...input } = out.loosen
    const r = await runWithRls(db, tenantId, (tx) => recordLoosening(tx, tenantId, projectId, { ...input, reason: why }, utcDateKey()))
    if (r.recorded) {
      wrote.push(`proposal ${JSON.stringify(input.title)} (applies ${r.applyOn})`)
      announced = { id: r.id, applyOn: r.applyOn, title: input.title, body: input.body }
    }
  }
  if (announced) await announceProposal(db, tenantId, env, projectId, announced)
  for (const m of out.addMeans) {
    const r = await runWithRls(db, tenantId, (tx) => recordAddMeans(tx, tenantId, projectId, m))
    if (r.ok && r.value.recorded) wrote.push(`proposal: set up ${m.strategy}`)
  }
  const known = new Set(lever.discovery.strategies.map((s) => s.slug))
  const upserts = [...new Map(out.strategyUpserts.map((u) => [u.slug, u])).values()]
  const archives = upserts.filter((u) => u.archived && activeStrategies.has(u.slug))
  const freeSlots = config.targetActiveStrategies - activeStrategies.size + archives.length
  const additions = upserts.filter((u) => !u.archived && !known.has(u.slug)).slice(0, Math.max(freeSlots, 0))
  for (const u of [...archives, ...additions]) {
    const { why, signals, ...strategy } = u
    const r = await runWithRls(db, tenantId, (tx) => upsertDiscoveryStrategy(tx, tenantId, STAGE_CALLER, projectId, { ...strategy, reason: why }, signals))
    if (r.ok) wrote.push(`${u.archived ? 'archived' : 'registered'} strategy ${u.slug}`)
  }

  const firstLine = out.report.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? 'Report ready.'
  return ok({
    kind: 'evaluate',
    summary: `${sufficient ? firstLine : 'Too few settled sends to judge replies.'}${wrote.length > 0 ? ` Wrote: ${wrote.join(', ')}.` : ''}`,
    report: out.report,
    wrote,
  })
}

const frameReviewSchemaFor = (salesStrategy: string) => z.object({
  frame: frameBodySchema.omit({ reason: true }).extend({
    salesStrategyEdits: z.array(sectionEditSchemaFor(salesStrategy)),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(2000),
    why: changeReasonSchema,
  }).nullable(),
  note: z.string().min(1).max(2000),
})

const framePeriodLine = ({ start, trials, positive }: FramePeriod): string =>
  `- ${start === null ? 'from the first send' : `from ${start.day}, started ${BY[start.by]}${why(start.reason)}`}: n=${trials.toFixed(1)} · positive ${positive} (${pct(positive, trials)})`

// The frame has nobody else to report to: a notice that could not go out
// leaves the cycle's log line.
async function reportNoFrame(db: Db, tenantId: TenantId, env: HostedEnv, projectId: ProjectId, frameStart: string | null, note: string): Promise<void> {
  const run = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => runWithRls(db, tenantId, fn)
  try {
    const [project] = await run((tx) => tx.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1))
    const sent = await notify(run, tenantId, notifyCtxOf(env), {
      category: 'insight',
      // Once per frame: the review reruns daily while the signal stays open.
      reference: `frame-review:${projectId}:${frameStart ?? 'start'}`,
      subject: `${project?.name ?? 'Your project'}: a new frame would not fix the replies`,
      body: note,
      link: '/dashboard',
    })
    if (!sent.ok) console.warn(`[frame review] notice failed for ${projectId}: ${sent.error}`)
  } catch (e) {
    console.warn(`[frame review] notice failed for ${projectId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Stage: the outer layer's review, only on a day the frame signal is open and
// no loosening or new frame waits on the person. It writes the next frame
// whole, or says why none would help.
export async function runFrameReview(db: Db, tenantId: TenantId, env: HostedEnv, projectId: ProjectId): Promise<ServiceResult<{ summary: string }>> {
  const judged = await gather(db, tenantId, projectId)
  if (!judged.ok) return judged
  const { docs, config, evidence, lever, proposals, reach } = judged.value
  const pending = proposals.find((p): p is PendingLoosen | PendingFrame => p.status === 'pending' && p.change.kind !== 'add-means')
  if (pending) {
    await announceProposal(db, tenantId, env, projectId, { id: pending.id, applyOn: pending.change.applyOn, title: pending.title, body: pending.body })
    return ok({ summary: `a proposal waits on the person: ${pending.title}` })
  }
  // Today's decision may be from before a frame the person started today.
  if (evidence.frameStart === utcDateKey()) return ok({ summary: 'the frame started today' })
  const signal = lever.todaysDecision?.frame
  if (!signal?.open) return ok({ summary: 'the frame signal is closed' })
  const [history, mode] = await Promise.all([frameHistory(db, projectId, config), getOutboundMode(db, projectId)])
  const taken = lever.discovery.strategies.map((st) => st.slug)
  const cycle = mode === 'send'
    ? 'it sends only email, and only to an address the organization itself publishes (large enterprises seldom publish one); a form or SNS contact waits for the person to send it by hand'
    : 'it drafts each message on the frame\'s channels for the person to send'

  const prompt = `You are Ace, reviewing a project's frame: who it reaches, what it leads with, where it finds them and on which channels. Today is ${utcDateKey()}.

## Goal
The frame is not getting positive replies: ${signal.trials.toFixed(1)} trials since it started, ${signal.positive} positive (${pct(signal.positive, signal.trials)}); P(positive rate < ${FRAME_SIGNAL.floorRate * 100}%) = ${signal.pBelow.toFixed(2)}. Inside it the loop has tried angles, search strategies and Target adjustments. Write the one new frame the evidence makes most likely to get positive replies from organizations that can use and buy the product, unlike every frame so far. Only what the daily cycle does by itself tests a frame: ${cycle}. Change who to reach, what to lead with, where to find them and on which channels; never the product's facts or price.

## Business (fixed)
${docs.business}

## Current sales strategy
${docs.salesStrategy}

Channels on: ${channelList(reach.outboundChannels)} · countries: ${countryList(reach.targetCountries)} · language: ${reach.targetLanguage}

## Frames so far (oldest first; each ran until the next started, the last is the current one)
${history.map(framePeriodLine).join('\n')}

${measuredSections(judged.value)}

## Output
- frame: title naming the change (≤ 120 chars); body for the person: the numbers behind the review, what was tried, the new hypothesis and how it differs from every frame so far, and what it means for them; why: one short line for the change log; salesStrategyEdits: each sales strategy section the frame changes, written whole; a section left out stays as it is; outboundChannels, targetCountries, targetLanguage: the frame's, changed or not ([] countries for any); variants: 2–${config.maxActiveArms} angles for the new frame, each a label, a subject pattern ≤ 80 chars using only {{org}} / {{name}} / {{signal}}, and a 2–5 line body approach; strategies: 2–${config.maxActiveStrategies} search strategies, each a new kebab-case slug (not ${taken.join(', ') || 'none taken'}) and a 2–5 line approach: where and how to search, and why it should work. It applies tomorrow unless the person stops it, and measuring restarts then. Never repeat a frame the person stopped.
- frame: null only when the replies show that no frame would get positives (the price, a missing capability); note then says why, with the evidence, to the person.
- note: otherwise one line.`

  let out: z.infer<ReturnType<typeof frameReviewSchemaFor>>
  try {
    out = await callLlmJson(env, 'evaluate', { prompt, schema: frameReviewSchemaFor(docs.salesStrategy) })
  } catch (e) {
    if (e instanceof LlmError) return err('BAD_GATEWAY', 'Frame review failed upstream', e.message)
    throw e
  }
  if (out.frame === null) {
    await reportNoFrame(db, tenantId, env, projectId, evidence.frameStart, out.note)
    return ok({ summary: `no new frame: ${out.note}` })
  }
  const { title, body, why: reason, ...frame } = out.frame
  const r = await runWithRls(db, tenantId, (tx) => recordFrame(tx, tenantId, projectId, { ...frame, title, body, reason }, { salesStrategyId: docs.salesStrategyId, salesStrategy: docs.salesStrategy, reach, mode }, utcDateKey(), config))
  if (!r.recorded) return ok({ summary: `no new frame: ${r.why}` })
  await announceProposal(db, tenantId, env, projectId, { id: r.id, applyOn: r.applyOn, title, body })
  return ok({ summary: `proposed a new frame: ${title} (applies ${r.applyOn})` })
}
