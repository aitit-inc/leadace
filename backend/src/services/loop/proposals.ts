// What Ace hands the person to decide (product_principles §2.2). A loosening or
// a new frame applies on its day unless the person applies it sooner or stops
// it, through the same writer as every other change. A means waits for the
// person and is applied once its playbook is approved.
import { z } from 'zod'
import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { discoveryStrategies, messageVariants, proposals, type OutboundMode } from '../../db/schema'
import type { Db } from '../../db/connection'
import { discoveryStrategySchema, type ProjectId, type ProjectRef, type TenantId } from '../../domain/ids'
import type { AllowedSendCountry } from '../../domain/country'
import { hostedChannels, type OutboundChannel } from '../../domain/outbound-channel'
import type { JobOrigin } from '../../domain/jobs'
import type { ChangeAuthor, ReachSettings } from '../../domain/loop/change'
import type { LeverConfig } from '../../domain/loop/config'
import {
  applyOnFor,
  frameReach,
  freshVariantIds,
  loosening,
  sameReach,
  stillApplies,
  PROPOSAL_STATUSES,
  type Frame,
  type FrameBody,
  type ProposalStatus,
  type ProposedChange,
} from '../../domain/loop/proposal'
import { ok, err, type ServiceResult } from '../result'
import { resolveProject } from '../projects'
import { loadLeverConfig, loadProjectOutboundAllowlist } from '../project-settings'
import { applyFrameChange, applyReachChange, loadReach } from './change'

export const listProposalsQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
})
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>

export const addMeansBodySchema = z.object({
  strategy: discoveryStrategySchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  // A sentence addressed to Ace: the Web UI sends it to the chat as it is.
  instruction: z.string().min(1).max(500),
})
export type AddMeansBody = z.infer<typeof addMeansBodySchema>

export type ProposalRow = {
  id: number
  change: ProposedChange
  title: string
  body: string
  status: ProposalStatus
  createdAt: Date
}

const cols = {
  id: proposals.id,
  change: proposals.change,
  title: proposals.title,
  body: proposals.body,
  status: proposals.status,
  createdAt: proposals.createdAt,
}

const kindIs = (kind: ProposedChange['kind']) => sql`${proposals.change}->>'kind' = ${kind}`
// The kinds that apply on their day; one of them is pending at a time.
const appliesOnItsDay = sql`${proposals.change}->>'kind' IN ('loosen', 'frame')`

export type RecordLooseningResult =
  | { recorded: true; id: number; applyOn: string }
  | { recorded: false; why: 'one is pending' | 'loosens nothing' }

export type RecordAddMeansResult = { recorded: true; id: number } | { recorded: false; why: 'asked before' }

export type LoosenInput = {
  outboundChannels: OutboundChannel[] | null
  targetCountries: AllowedSendCountry[] | null
  title: string
  body: string
  reason: string
}

export async function recordLoosening(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  input: LoosenInput,
  today: string,
): Promise<RecordLooseningResult> {
  const diff = loosening(await loadProjectOutboundAllowlist(db, projectId), input)
  if (diff === null) return { recorded: false, why: 'loosens nothing' }
  const applyOn = applyOnFor(today)
  const change: ProposedChange = { kind: 'loosen', applyOn, reason: input.reason, ...diff }
  const [row] = await db
    .insert(proposals)
    .values({ tenantId, projectId, change, title: input.title, body: input.body })
    .onConflictDoNothing()
    .returning({ id: proposals.id })
  return row ? { recorded: true, id: row.id, applyOn } : { recorded: false, why: 'one is pending' }
}

export async function recordAddMeans(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  body: AddMeansBody,
): Promise<ServiceResult<RecordAddMeansResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const change: ProposedChange = { kind: 'add-means', strategy: body.strategy, instruction: body.instruction }
  const [row] = await db
    .insert(proposals)
    .values({ tenantId, projectId: resolved.value, change, title: body.title, body: body.body })
    .onConflictDoNothing()
    .returning({ id: proposals.id })
  return ok(row ? { recorded: true, id: row.id } : { recorded: false, why: 'asked before' })
}

type FrameInput = Omit<FrameBody, 'reason'>

type FrameLimits = Pick<LeverConfig, 'maxActiveArms' | 'maxActiveStrategies'>

// The frame as it would apply now: its angles take ids no variant has used,
// a strategy slug the project already used is left out (a slug is a measured
// identity).
async function frameOf(
  db: Db,
  projectId: ProjectId,
  input: FrameInput,
  reach: ReachSettings,
  today: string,
  limits: FrameLimits,
): Promise<Frame | null> {
  const [variantRows, strategyRows] = await Promise.all([
    db.select({ id: messageVariants.variantId }).from(messageVariants).where(eq(messageVariants.projectId, projectId)),
    db.select({ slug: discoveryStrategies.slug }).from(discoveryStrategies).where(eq(discoveryStrategies.projectId, projectId)),
  ])
  const taken = new Set(strategyRows.map((r) => r.slug))
  const strategies = [...new Map(input.strategies.filter((st) => !taken.has(st.slug)).map((st) => [st.slug, st])).values()]
    .slice(0, limits.maxActiveStrategies)
  if (strategies.length < 2) return null
  const variants = input.variants.slice(0, limits.maxActiveArms)
  const ids = freshVariantIds(new Set(variantRows.map((r) => r.id)), today, variants.length)
  return {
    salesStrategy: input.salesStrategy,
    reach: frameReach(reach, input),
    variants: variants.map((v, i) => ({ variantId: ids[i]!, ...v })),
    strategies,
  }
}

export type RecordFrameResult =
  | { recorded: true; id: number; applyOn: string }
  | { recorded: false; why: 'one is pending' | 'too few new strategies' | 'Ace sends on none of its channels' }

// `read` is what the review read: the sales strategy version and the reach the
// frame is written against, however long the model took, and the outbound mode.
export async function recordFrame(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  input: FrameInput & { title: string; body: string; reason: string },
  read: { salesStrategyId: number; reach: ReachSettings; mode: OutboundMode },
  today: string,
  limits: FrameLimits,
): Promise<RecordFrameResult> {
  // A frame is measured only by what the cycle sends; one it cannot send on is never measured.
  if (!input.outboundChannels.some((c) => hostedChannels(read.mode).includes(c))) return { recorded: false, why: 'Ace sends on none of its channels' }
  const frame = await frameOf(db, projectId, input, read.reach, today, limits)
  if (frame === null) return { recorded: false, why: 'too few new strategies' }
  const applyOn = applyOnFor(today)
  const change: ProposedChange = { kind: 'frame', applyOn, reason: input.reason, salesStrategyFrom: read.salesStrategyId, reachFrom: read.reach, ...frame }
  const [row] = await db
    .insert(proposals)
    .values({ tenantId, projectId, change, title: input.title, body: input.body })
    .onConflictDoNothing()
    .returning({ id: proposals.id })
  return row ? { recorded: true, id: row.id, applyOn } : { recorded: false, why: 'one is pending' }
}

// A frame the person approved in the chat (apply_frame_change) or the Web UI:
// it applies now, through the same writer as a proposal, and what Ace proposed
// under the old frame no longer applies.
export async function applyFrameNow(
  db: Db,
  tenantId: TenantId,
  origin: JobOrigin,
  projectRef: ProjectRef,
  body: FrameBody,
): Promise<ServiceResult<{ applied: true }>> {
  if (origin !== 'ui' && origin !== 'chat') return err('FORBIDDEN', 'A new frame needs the person\'s approval')
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const [config, reach] = await Promise.all([loadLeverConfig(db, resolved.value), loadReach(db, resolved.value)])
  const { reason, ...input } = body
  const frame = await frameOf(db, resolved.value, input, reach, new Date().toISOString().slice(0, 10), config)
  if (frame === null) return err('INVALID_INPUT', 'A frame needs at least two search strategies with slugs the project has not used')
  // Locked before the policy, as applying a proposal locks it.
  const stale = await db.select({ id: proposals.id }).from(proposals)
    .where(and(eq(proposals.projectId, resolved.value), eq(proposals.status, 'pending'), appliesOnItsDay))
    .for('update')
  const applied = await applyFrameChange(db, tenantId, resolved.value, frame, { actor: 'user', reason }, (current) => sameReach(current.reach, reach))
  if (!applied) return err('CONFLICT', 'The settings or the frame\'s names changed meanwhile; nothing changed')
  if (stale.length > 0) await db.update(proposals).set({ status: 'outdated' }).where(inArray(proposals.id, stale.map((p) => p.id)))
  return ok({ applied: true })
}

export async function listProposals(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  query: ListProposalsQuery,
): Promise<ServiceResult<{ proposals: ProposalRow[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const rows = await db
    .select(cols)
    .from(proposals)
    .where(and(eq(proposals.projectId, resolved.value), ...(query.status ? [eq(proposals.status, query.status)] : [])))
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
  return ok({ proposals: rows })
}

// The pending ones and every one made since `since`, newest first.
export async function recentProposals(db: Db, projectId: ProjectId, since: Date): Promise<ProposalRow[]> {
  return db
    .select(cols)
    .from(proposals)
    .where(and(eq(proposals.projectId, projectId), or(eq(proposals.status, 'pending'), gte(proposals.createdAt, since))))
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
}

// Applies a loosening or a frame as written. When what it was written against
// changed since, it is outdated and nothing applies.
async function applyProposal(
  db: Db,
  tenantId: TenantId,
  proposalId: number,
): Promise<ServiceResult<{ id: number; status: ProposalStatus }>> {
  const [p] = await db
    .select({ projectId: proposals.projectId, change: proposals.change })
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.tenantId, tenantId), eq(proposals.status, 'pending')))
    .for('update')
  if (!p) return err('CONFLICT', 'No pending proposal with that id')
  const { change } = p
  const projectId = p.projectId as ProjectId
  if (change.kind === 'add-means') return err('CONFLICT', 'A means applies once its playbook is approved')
  const by: ChangeAuthor = { actor: 'ace', reason: change.reason }
  const applied = change.kind === 'loosen'
    ? (await applyReachChange(
        db,
        tenantId,
        projectId,
        { outboundChannels: change.outboundChannels?.to, targetCountries: change.targetCountries?.to },
        by,
        (current) => stillApplies(change, current),
      )) !== null
    : await applyFrameChange(
        db,
        tenantId,
        projectId,
        change,
        by,
        (current) => current.salesStrategyId === change.salesStrategyFrom && sameReach(change.reachFrom, current.reach),
      )
  const status = applied ? 'applied' : 'outdated'
  await db.update(proposals).set({ status }).where(eq(proposals.id, proposalId))
  return ok({ id: proposalId, status })
}

// The person's call, so a Web UI action: the agent never applies or stops one.
export async function applyProposalNow(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  proposalId: number,
): Promise<ServiceResult<{ id: number; status: ProposalStatus }>> {
  if (caller !== 'browser') return err('FORBIDDEN', 'Applying a proposal is a Web UI action')
  return applyProposal(db, tenantId, proposalId)
}

export async function stopProposal(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  proposalId: number,
): Promise<ServiceResult<{ id: number; status: ProposalStatus }>> {
  if (caller !== 'browser') return err('FORBIDDEN', 'Stopping a proposal is a Web UI action')
  const [row] = await db
    .update(proposals)
    .set({ status: 'stopped' })
    .where(and(eq(proposals.id, proposalId), eq(proposals.tenantId, tenantId), eq(proposals.status, 'pending')))
    .returning({ id: proposals.id, status: proposals.status })
  if (!row) return err('CONFLICT', 'No pending proposal with that id')
  return ok(row)
}

// The tick's first step: a loosening or a frame nobody stopped by its day
// applies. One the person resolved in the meantime is theirs and is skipped.
export async function applyDueProposals(db: Db, tenantId: TenantId, projectId: ProjectId, today: string): Promise<void> {
  const due = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(
      eq(proposals.projectId, projectId),
      eq(proposals.status, 'pending'),
      appliesOnItsDay,
      sql`${proposals.change}->>'applyOn' <= ${today}`,
    ))
    .orderBy(asc(proposals.id))
  for (const { id } of due) await applyProposal(db, tenantId, id)
}

export async function applyAddMeans(db: Db, tenantId: TenantId, projectId: ProjectId, strategy: string): Promise<void> {
  await db
    .update(proposals)
    .set({ status: 'applied' })
    .where(and(
      eq(proposals.tenantId, tenantId),
      eq(proposals.projectId, projectId),
      eq(proposals.status, 'pending'),
      kindIs('add-means'),
      sql`${proposals.change}->>'strategy' = ${strategy}`,
    ))
}
