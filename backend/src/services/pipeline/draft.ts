// Stage: draft — compose one outreach message per reachable prospect and hand
// it to the send path (outbound/SKILL.md, server-side, email plus form / SNS
// drafts). The project's outbound mode still decides draft vs send inside
// sendAndRecord; this stage decides only what to say and whether to skip.
import { z } from 'zod'
import type { Db } from '../../db/connection'
import type { Channel, OutboundChannel } from '../../db/schema'
import type { ProjectId, TenantId } from '../../domain/ids'
import type { JobParamsOf, JobResult } from '../../domain/jobs'
import { ok, type ServiceResult } from '../result'
import { callGeminiJson, GeminiError, HOSTED_MODEL } from '../gemini'
import { listReachable, type ReachableProspect } from '../prospects'
import { pickMessageVariant, type PickedVariant } from '../message-variants'
import { getProjectSettings, type ProjectSettingsRow } from '../project-settings'
import { recordOutreachWithInquiry, sendAndRecord, skipProspect } from '../outreach'
import { assertTenantComplianceReady } from '../tenants'
import { editionOf, loadDoc, loadMasterDoc, requireStrategyDocs, sendContextOf, type HostedEnv } from './context'
import { languageNameOf } from '../../domain/locale'
import { utcDateKey } from '../../domain/time'
import { runWithRls } from '../../db/rls'

export type DraftBatch = {
  targets: ReachableProspect[]
  outboundMode: 'send' | 'draft'
  // Reachable prospects the hosted agent cannot deliver to (form / SNS while
  // in send mode need a browser — the plugin's hands).
  needsHands: number
  quotaMessage: string | null
}

// Which prospects this run will write to, and the batch-wide context every
// composition shares. Loaded once per job, not per prospect.
export async function loadDraftBatch(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  params: JobParamsOf<'draft'>,
): Promise<ServiceResult<DraftBatch>> {
  const compliance = await assertTenantComplianceReady(db, tenantId)
  if (!compliance.ok) return compliance
  const reachable = await listReachable(db, tenantId, editionOf(env), projectId, {
    limit: params.prospectIds ? params.prospectIds.length : params.count ?? 30,
    ...(params.prospectIds ? { prospectIds: params.prospectIds } : {}),
  })
  if (!reachable.ok) return reachable
  const r = reachable.value
  const deliverable = r.prospects.filter((p) => r.outboundMode === 'draft' || p.email !== null)
  return ok({
    targets: deliverable,
    outboundMode: r.outboundMode,
    needsHands: r.prospects.length - deliverable.length,
    quotaMessage: r.message ?? null,
  })
}

// Plain data (it is a Workflow step's output): the settings fields the prompt
// and the send path read, not the full row.
export type CompositionSettings = Pick<
  ProjectSettingsRow,
  'targetLanguage' | 'outboundChannels' | 'inquiryLandingEnabled' | 'inquiryChatBrief' | 'inquiryOneLiner' | 'inquiryCtaType'
>
export type CompositionContext = {
  business: string
  salesStrategy: string
  learnings: string | null
  guidelines: string
  settings: CompositionSettings
}

export async function loadCompositionContext(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<CompositionContext>> {
  const docs = await requireStrategyDocs(db, tenantId, projectId)
  if (!docs.ok) return docs
  const [learnings, guidelines, settings] = await Promise.all([
    loadDoc(db, tenantId, projectId, 'learnings'),
    loadMasterDoc(db, 'tpl_email_guidelines'),
    getProjectSettings(db, tenantId, projectId, null),
  ])
  if (!settings.ok) return settings
  const { targetLanguage, outboundChannels, inquiryLandingEnabled, inquiryChatBrief, inquiryOneLiner, inquiryCtaType } = settings.value
  return ok({
    ...docs.value,
    learnings,
    guidelines,
    settings: { targetLanguage, outboundChannels, inquiryLandingEnabled, inquiryChatBrief, inquiryOneLiner, inquiryCtaType },
  })
}

// Flat on purpose: a root-level union does not survive the model's response
// schema; the pair of nullable fields per decision does.
const compositionSchema = z.object({
  decision: z.enum(['send', 'skip']),
  subject: z.string().max(200).nullable(),
  body: z.string().max(4000).nullable(),
  skipReason: z.enum(['bad_timing', 'no_fresh_material']).nullable(),
  skipNote: z.string().max(300).nullable(),
})
type Composition =
  | { decision: 'send'; subject: string; body: string }
  | { decision: 'skip'; reason: 'bad_timing' | 'no_fresh_material'; note: string }

function toComposition(raw: z.infer<typeof compositionSchema>): Composition | null {
  if (raw.decision === 'send') {
    return raw.subject && raw.body ? { decision: 'send', subject: raw.subject, body: raw.body } : null
  }
  return raw.skipReason ? { decision: 'skip', reason: raw.skipReason, note: raw.skipNote ?? raw.skipReason } : null
}

// tpl_channel_policy's ladder, restricted to what the hosted agent can deliver
// by itself: email always; form / SNS only as drafts a person submits.
export function pickChannel(
  p: ReachableProspect,
  enabled: readonly OutboundChannel[],
  outboundMode: 'send' | 'draft',
): Exclude<Channel, 'platform'> | null {
  const available: Exclude<Channel, 'platform'>[] = []
  if (p.email) available.push('email')
  if (outboundMode === 'draft') {
    if (p.snsAccounts?.linkedin) available.push('sns_linkedin')
    if (p.contactFormUrl) available.push('form')
    if (p.snsAccounts?.x) available.push('sns_twitter')
  }
  const enabledSet = new Set<string>(enabled)
  const measured = p.channelAffinity.map((c) => c.channel).filter((c): c is Exclude<Channel, 'platform'> => c !== 'platform')
  const order = [...measured, ...available.filter((c) => !measured.includes(c))]
  return order.find((c) => available.includes(c) && enabledSet.has(c)) ?? null
}

function compositionPrompt(args: {
  p: ReachableProspect
  channel: Exclude<Channel, 'platform'>
  variant: PickedVariant | null
  ctx: CompositionContext
  today: string
}): string {
  const { p, ctx, variant } = args
  const s = ctx.settings
  const cycle = p.cycle
  const inquiry = s.inquiryLandingEnabled
    ? `Inquiry landing is ON (CTA type ${s.inquiryCtaType}). Primary CTA: invite a short recipient-led AI conversation on the landing page — the backend appends its URL, never write one. Backup CTA: reply${s.inquiryCtaType === 'meeting' ? ' or a call' : ' only (no scheduling fallback in signup mode)'}.${s.inquiryChatBrief ? ` The landing chat can answer about: ${s.inquiryChatBrief.slice(0, 600)}` : ''}${s.inquiryOneLiner ? ` Landing tagline (do not contradict): ${s.inquiryOneLiner}` : ''}`
    : 'Inquiry landing is OFF: the only CTA is a reply (or the scheduling link named in SALES_STRATEGY Sender Information when it exists). Never reference or invent a landing URL.'
  const cycleNote =
    cycle.kind === 'first'
      ? 'First touch.'
      : cycle.kind === 'short_cycle_followup'
        ? `Day-scale follow-up, touch ${cycle.touchNumber} after silence on "${cycle.lastOutreach?.subject ?? ''}" (${cycle.lastOutreach?.sentAt ?? ''}). Keep it short and low-friction — a polite nudge adding one angle or fresh signal; do NOT skip for lack of new material; the subject must differ from the last one; never a bare "Re:" / "Following up".`
        : cycle.kind === 'no_response'
          ? `Months-scale re-approach after silence (last touch "${cycle.lastOutreach?.subject ?? ''}" on ${cycle.lastOutreach?.sentAt ?? ''}). Acknowledge lightly and lead with what is new (a fresh signal, a different angle from matchReason). With genuinely nothing new → decision "skip" with reason no_fresh_material. Subject must differ from the last one.`
          : `Re-approach after a substantive response (${cycle.lastResponse?.responseType ?? 'reply'}${cycle.lastResponse?.rejectionFeedback ? `, stated reason: ${cycle.lastResponse.rejectionFeedback.primaryReason}${cycle.lastResponse.rejectionFeedback.freeText ? ` — "${cycle.lastResponse.rejectionFeedback.freeText}"` : ''}` : ''}). Open against the actual objection without quoting it, then lead with what has concretely changed. Nothing changed → decision "skip" (no_fresh_material). Collegial, never pitchy.`
  const signals = [
    ...(p.recentSignals ?? []),
    ...(p.overview.includes('## Recent Signals') ? [p.overview.slice(p.overview.indexOf('## Recent Signals'))] : []),
  ]
  return `You are Ace, writing one ${args.channel === 'email' ? 'cold email' : args.channel === 'form' ? 'contact-form message' : 'social DM'} for one recipient, in ${languageNameOf(s.targetLanguage)}. Today is ${args.today}.

## The business (BUSINESS.md)
${ctx.business}

## Strategy (SALES_STRATEGY.md — Messaging governs what to emphasize and what never to claim; Sender Information gives the light sign-off)
${ctx.salesStrategy}

## Evidence-cited learnings ([body] / [timing] / [channel] are composition hints, not rules)
${ctx.learnings ?? '(none yet)'}

## Writing guidelines (hard rules apply; the server refuses bodies that break the mechanical ones)
${ctx.guidelines}

## Message angle (weighted draw — write to this brief)
${variant ? `Variant ${variant.variantId}${variant.label ? ` (${variant.label})` : ''}\nSubject pattern: ${variant.subjectPattern} — render it, substituting {{org}} / {{name}} / {{signal}} with real values; never leave a placeholder.\nBody approach: ${variant.bodyApproach ?? '(none — the guidelines\' shape governs)'}` : 'No registered angle: write a one-off subject per the guidelines.'}

## Recipient
${JSON.stringify(
  {
    name: p.name,
    contactName: p.contactName,
    organizationIndustry: p.industry,
    website: p.websiteUrl,
    overview: p.overview,
    matchReason: p.matchReason,
    hypothesis: p.hypothesis,
    notes: p.notes,
    country: p.country,
    channel: args.channel,
  },
  null,
  1,
)}
Assertable facts about them are ONLY the overview, matchReason, notes and the dated signals below. hypothesis fields are inferred, never observed — use them to choose the angle, never as claims about the recipient.
Signals: ${signals.length > 0 ? signals.join(' | ') : '(none — do not invent one; open on their situation plainly)'}

## Cycle
${cycleNote}

## CTA mode
${inquiry}

## Decide first
Judge from the material above whether a concrete, clearly negative event (layoffs, wind-down, buyer left, post-acquisition freeze) makes now a bad moment → decision "skip", reason bad_timing, one-line note. When in doubt, send.

## Output
decision "send": subject (40–60 characters, recipient benefit, no "Proposal" / "Announcement") and body — the complete message in the recipient's language: salutation per the guidelines, personalization woven through the whole body from overview and matchReason, one reply CTA, light sign-off from Sender Information. No footer, no legal lines, no links to our own hosts, no placeholders; skipReason and skipNote null. ${args.channel === 'email' ? '' : args.channel === 'form' ? 'Concise for a form field; the subject is the form topic line.' : 'Short DM; subject is unused but still required.'}
decision "skip": skipReason and a one-line skipNote; subject and body null.`
}

export type DraftOutcome =
  | { kind: 'drafted'; outreachId: number; channel: Channel; variantId: string | null }
  | { kind: 'sent'; outreachId: number; channel: Channel; variantId: string | null }
  | { kind: 'skipped'; reason: string }
  | { kind: 'needs_hands' }
  | { kind: 'failed'; error: string }

export async function draftOne(
  db: Db,
  tenantId: TenantId,
  env: HostedEnv,
  projectId: ProjectId,
  p: ReachableProspect,
  batch: Pick<DraftBatch, 'outboundMode'>,
  ctx: CompositionContext,
): Promise<DraftOutcome> {
  const channel = pickChannel(p, ctx.settings.outboundChannels, batch.outboundMode)
  if (!channel) return { kind: 'needs_hands' }
  const picked = await pickMessageVariant(db, tenantId, projectId)
  const variant = picked.ok ? picked.value : null
  let composed: Composition | null
  try {
    composed = toComposition(
      await callGeminiJson({
        apiKey: env.GEMINI_API_KEY,
        model: HOSTED_MODEL,
        prompt: compositionPrompt({ p, channel, variant, ctx, today: utcDateKey() }),
        schema: compositionSchema,
        thinking: 'LOW',
        maxOutputTokens: 8192,
      }),
    )
  } catch (e) {
    if (e instanceof GeminiError) return { kind: 'failed', error: `composition failed: ${e.message}` }
    throw e
  }
  if (!composed) return { kind: 'failed', error: 'composition failed: the model answered without a usable subject and body' }
  if (composed.decision === 'skip') {
    const skipped = await runWithRls(db, tenantId, (tx) =>
      skipProspect(tx, tenantId, { projectId, prospectId: p.prospectId, channel, reason: composed.reason, note: composed.note }),
    )
    if (!skipped.ok) return { kind: 'failed', error: `skip not recorded: ${skipped.error}` }
    return { kind: 'skipped', reason: `${composed.reason}: ${composed.note}` }
  }
  const variantId = variant?.variantId ?? null
  if (channel === 'email') {
    const sent = await runWithRls(db, tenantId, (tx) =>
      sendAndRecord(tx, tenantId, editionOf(env), sendContextOf(env), {
        projectId,
        prospectId: p.prospectId,
        subject: composed.subject,
        body: composed.body,
        ...(variantId ? { variantId } : {}),
      }),
    )
    if (!sent.ok) return { kind: 'failed', error: `${sent.error}${sent.detail ? ` — ${typeof sent.detail === 'string' ? sent.detail : JSON.stringify(sent.detail)}` : ''}` }
    return sent.value.mode === 'sent'
      ? { kind: 'sent', outreachId: sent.value.outreachId, channel, variantId }
      : { kind: 'drafted', outreachId: sent.value.outreachId, channel, variantId }
  }
  // Form / SNS only reach here in draft mode (pickChannel), so the row lands
  // as pending_review with the footer baked in for the person to submit.
  const recorded = await runWithRls(db, tenantId, (tx) =>
    recordOutreachWithInquiry(tx, tenantId, editionOf(env), sendContextOf(env), {
      projectId,
      prospectId: p.prospectId,
      channel,
      subject: composed.subject,
      body: composed.body,
      ...(variantId && channel === 'form' ? { variantId } : {}),
    }),
  )
  if (!recorded.ok) return { kind: 'failed', error: `${recorded.error}` }
  return { kind: 'drafted', outreachId: recorded.value.outreachLogId, channel, variantId }
}

export type DraftResult = Extract<JobResult, { kind: 'draft' }>

export function summarizeDraftOutcomes(outcomes: DraftOutcome[], needsHandsUpfront: number, note: string | null = null): DraftResult {
  const drafted = outcomes.filter((o) => o.kind === 'drafted').length
  const sent = outcomes.filter((o) => o.kind === 'sent').length
  const skipped = outcomes.filter((o) => o.kind === 'skipped').length
  const failed = outcomes.filter((o) => o.kind === 'failed').length
  const needsHands = needsHandsUpfront + outcomes.filter((o) => o.kind === 'needs_hands').length
  const variantIds = [...new Set(outcomes.flatMap((o) => (o.kind === 'drafted' || o.kind === 'sent') && o.variantId ? [o.variantId] : []))]
  // The first distinct failure reasons travel in the summary: a mailbox or
  // compliance problem is what the person needs to read, not a count.
  const reasons = [...new Set(outcomes.flatMap((o) => (o.kind === 'failed' ? [o.error] : [])))].slice(0, 2)
  const parts = [
    sent > 0 ? `${sent} sent` : null,
    drafted > 0 ? `${drafted} drafted for review` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    failed > 0 ? `${failed} failed (${reasons.join('; ')})` : null,
    needsHands > 0 ? `${needsHands} need a browser (form / SNS)` : null,
  ].filter((x): x is string => x !== null)
  return {
    kind: 'draft',
    summary: [parts.length > 0 ? parts.join(', ') + '.' : 'No reachable prospects.', note].filter((x) => x !== null).join(' '),
    drafted,
    sent,
    skipped,
    failed,
    needsHands,
    variantIds,
  }
}
