// The policy's only writer (#793): every change to an option or a policy
// document lands with its policy_changes row in the same transaction.
import { and, desc, eq, gte, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm'
import { discoveryStrategies, leverState, messageVariants, policyChanges, projectDocuments } from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { LIFT_MIN, LIFT_MAX, type TargetingAxisLift } from '../../domain/loop/allocation'
import type { TickDecision } from '../../domain/loop/decide'
import {
  optionOps,
  type ChangeAuthor,
  type DocumentTarget,
  type LoggedChange,
  type LoggedRuleChange,
  type OptionTarget,
  type RuleArchiveReason,
} from '../../domain/loop/change'
import { COARSE_TO_FINES, type CoarseIndustry } from '../../domain/coarse-industry'
import type { MessageVariantRow, UpsertVariantBody } from '../message-variants'
import type { DiscoveryStrategyRow, UpsertDiscoveryStrategyBody } from '../discovery-strategies'

type ChangeRow = Omit<typeof policyChanges.$inferInsert, 'id' | 'tenantId' | 'projectId' | 'createdAt'>

// `createdAt` is not the column default: now() is the transaction's start, and
// a write that waited on the lock would sort before the one it waited for.
async function log(db: Db, tenantId: TenantId, projectId: ProjectId, rows: ChangeRow[], createdAt = new Date()): Promise<void> {
  if (rows.length === 0) return
  await db.insert(policyChanges).values(rows.map((r) => ({ ...r, tenantId, projectId, createdAt })))
}

// Held to commit, so a concurrent write to the same option or document waits
// and then reads the state this one left: the ops it logs are its own.
async function lockTarget(db: Db, projectId: ProjectId, target: string, key: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${projectId}:${target}:${key}`}))`)
}

function valueLiftCase(column: ReturnType<typeof sql>, lifts: TargetingAxisLift[]): ReturnType<typeof sql> {
  const nullLift = lifts.find((l) => l.value === null)?.lift ?? 1.0
  const branches = lifts.filter((l): l is { value: string; lift: number } => l.value !== null)
  const whens = branches.map((b) => sql` WHEN ${column} = ${b.value} THEN ${b.lift}::float8`)
  return sql`(CASE WHEN ${column} IS NULL THEN ${nullLift}::float8${sql.join(whens, sql``)} ELSE 1.0 END)`
}

// ELSE carries the 'other' lift (null, 'Other', legacy labels) — must keep
// folding exactly like coarseIndustry().
function industryLiftCase(column: ReturnType<typeof sql>, lifts: TargetingAxisLift[]): ReturnType<typeof sql> {
  const otherLift = lifts.find((l) => l.value === 'other')?.lift ?? 1.0
  const whens = lifts
    .filter((l): l is { value: string; lift: number } => l.value !== null && l.value !== 'other')
    .flatMap((l) => {
      const fines = COARSE_TO_FINES[l.value as CoarseIndustry] ?? []
      if (fines.length === 0) return []
      const list = sql.join(fines.map((f) => sql`${f}`), sql`, `)
      return [sql` WHEN TRIM(COALESCE(${column}, '')) IN (${list}) THEN ${l.lift}::float8`]
    })
  if (whens.length === 0) return sql`${otherLift}::float8`
  return sql`(CASE${sql.join(whens, sql``)} ELSE ${otherLift}::float8 END)`
}

// Archives or restores the options the tick decided on and returns the ones it
// moved: an option someone moved since the tick observed it is theirs. A
// restore re-reads the lost set under the lock, so an option a person brought
// back and archived again in between stays where they left it.
async function moveOptions<M extends { armId: string }>(db: Db, projectId: ProjectId, target: OptionTarget, moves: M[], to: 'archived' | 'active', now: Date): Promise<M[]> {
  if (moves.length === 0) return []
  // Sorted, so two writers taking several locks cannot deadlock.
  const decided = moves.map((m) => m.armId).sort()
  for (const id of decided) await lockTarget(db, projectId, target, id)
  const stillLost = to === 'active' ? new Set(await lostOptionIds(db, projectId, target)) : null
  const ids = stillLost === null ? decided : decided.filter((id) => stillLost.has(id))
  if (ids.length === 0) return []
  const archivedAt = to === 'archived' ? now : null
  const moved = target === 'variant'
    ? await db
        .update(messageVariants)
        .set({ archivedAt, updatedAt: now })
        .where(and(
          eq(messageVariants.projectId, projectId),
          inArray(messageVariants.variantId, ids),
          to === 'archived' ? isNull(messageVariants.archivedAt) : isNotNull(messageVariants.archivedAt),
        ))
        .returning({ id: messageVariants.variantId })
    : await db
        .update(discoveryStrategies)
        .set({ archivedAt, updatedAt: now })
        .where(and(
          eq(discoveryStrategies.projectId, projectId),
          inArray(discoveryStrategies.slug, ids),
          to === 'archived' ? isNull(discoveryStrategies.archivedAt) : isNotNull(discoveryStrategies.archivedAt),
        ))
        .returning({ id: discoveryStrategies.slug })
  return moves.filter((m) => moved.some((r) => r.id === m.armId))
}

// Only for a decision whose lever_decisions row this tick claimed.
export async function applyTickDecision(db: Db, tenantId: TenantId, projectId: ProjectId, cycleDate: string, decision: TickDecision): Promise<void> {
  const { channel: { affinity: channelAffinity }, targeting: { lifts: targetingLifts } } = decision.payload
  const now = new Date()
  // The day's changes are read back by their UTC day, so a tick that crosses
  // midnight logs on the day it decided for.
  const dayEnd = new Date(`${cycleDate}T23:59:59.999Z`)
  const rows: ChangeRow[] = []
  for (const [target, layer] of [['variant', decision.variants], ['strategy', decision.strategies]] as const) {
    for (const { armId, ...decided } of await moveOptions(db, projectId, target, layer.toArchive, 'archived', now)) {
      rows.push('reason' in decided
        ? { target, optionId: armId, op: 'archive', actor: 'rule', ruleReason: 'rotated', evidence: { pBest: decided.pBest, n: decided.n } }
        : { target, optionId: armId, op: 'archive', actor: 'rule', ruleReason: 'lost', evidence: decided })
    }
    for (const { armId, ...evidence } of await moveOptions(db, projectId, target, layer.toRestore, 'active', now)) {
      rows.push({ target, optionId: armId, op: 'restore', actor: 'rule', evidence })
    }
  }
  await log(db, tenantId, projectId, rows, now > dayEnd ? dayEnd : now)
  await db
    .insert(leverState)
    .values({
      projectId,
      tenantId,
      variantWeights: decision.variants.weights,
      strategyWeights: decision.strategies.weights,
      channelAffinity,
      targetingLifts,
      variantFlatStreak: decision.variants.flatStreak,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: leverState.projectId,
      set: {
        variantWeights: decision.variants.weights,
        strategyWeights: decision.strategies.weights,
        channelAffinity,
        targetingLifts,
        variantFlatStreak: decision.variants.flatStreak,
        updatedAt: now,
      },
    })

  // fresh_signal is deliberately absent — time-varying, applied at read time.
  await db.execute(sql`
    UPDATE project_prospects pp
    SET ordering_score = LEAST(${LIFT_MAX}::float8, GREATEST(${LIFT_MIN}::float8,
        ${industryLiftCase(sql`p.industry`, targetingLifts.industry)}
      * ${valueLiftCase(sql`o.employee_band::text`, targetingLifts.employeeBand)}
      * ${valueLiftCase(sql`UPPER(COALESCE(p.country, o.country))`, targetingLifts.country)}
    ))::real
    FROM prospects p
    JOIN organizations o ON o.id = p.organization_id
    WHERE pp.prospect_id = p.id AND pp.project_id = ${projectId}
  `)
}

type VariantWrite = Omit<UpsertVariantBody, 'reason'>

export const variantCols = {
  variantId: messageVariants.variantId,
  subjectPattern: messageVariants.subjectPattern,
  bodyApproach: messageVariants.bodyApproach,
  label: messageVariants.label,
  archivedAt: messageVariants.archivedAt,
  createdAt: messageVariants.createdAt,
  updatedAt: messageVariants.updatedAt,
}

const variantState = (v: Pick<MessageVariantRow, 'subjectPattern' | 'bodyApproach' | 'label' | 'archivedAt'>) => ({
  archived: v.archivedAt !== null,
  content: { subjectPattern: v.subjectPattern, bodyApproach: v.bodyApproach, label: v.label },
})

export async function applyVariantChange(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  body: VariantWrite,
  by: ChangeAuthor,
): Promise<MessageVariantRow | null> {
  await lockTarget(db, projectId, 'variant', body.variantId)
  const [before] = await db
    .select(variantCols)
    .from(messageVariants)
    .where(and(eq(messageVariants.projectId, projectId), eq(messageVariants.variantId, body.variantId)))
  const now = new Date()
  const archivedAt = body.archived ? now : null
  const [row] = await db
    .insert(messageVariants)
    .values({
      tenantId,
      projectId,
      variantId: body.variantId,
      subjectPattern: body.subjectPattern,
      bodyApproach: body.bodyApproach ?? null,
      label: body.label ?? null,
      archivedAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [messageVariants.projectId, messageVariants.variantId],
      set: {
        subjectPattern: body.subjectPattern,
        ...(body.bodyApproach !== undefined ? { bodyApproach: body.bodyApproach } : {}),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.archived !== undefined ? { archivedAt } : {}),
        updatedAt: now,
      },
    })
    .returning(variantCols)
  if (!row) return null
  const ops = optionOps(before ? variantState(before) : null, variantState(row))
  await log(db, tenantId, projectId, ops.map((op) => ({ target: 'variant' as const, optionId: row.variantId, op, ...by })))
  return row
}

type StrategyWrite = Omit<UpsertDiscoveryStrategyBody, 'reason'>

export const strategyCols = {
  slug: discoveryStrategies.slug,
  approach: discoveryStrategies.approach,
  archivedAt: discoveryStrategies.archivedAt,
  createdAt: discoveryStrategies.createdAt,
  updatedAt: discoveryStrategies.updatedAt,
}

const strategyState = (s: Pick<DiscoveryStrategyRow, 'approach' | 'archivedAt'>) => ({
  archived: s.archivedAt !== null,
  content: { approach: s.approach },
})

export async function applyStrategyChange(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  body: StrategyWrite,
  by: ChangeAuthor,
): Promise<DiscoveryStrategyRow | null> {
  await lockTarget(db, projectId, 'strategy', body.slug)
  const [before] = await db
    .select(strategyCols)
    .from(discoveryStrategies)
    .where(and(eq(discoveryStrategies.projectId, projectId), eq(discoveryStrategies.slug, body.slug)))
  const now = new Date()
  const archivedAt = body.archived === true ? now : null
  const [row] = await db
    .insert(discoveryStrategies)
    .values({ tenantId, projectId, slug: body.slug, approach: body.approach, archivedAt, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [discoveryStrategies.projectId, discoveryStrategies.slug],
      set: { approach: body.approach, archivedAt, updatedAt: now },
    })
    .returning(strategyCols)
  if (!row) return null
  const ops = optionOps(before ? strategyState(before) : null, strategyState(row))
  await log(db, tenantId, projectId, ops.map((op) => ({ target: 'strategy' as const, optionId: row.slug, op, ...by })))
  return row
}

type DocumentVersion = { id: number; createdAt: Date; approvedAt: Date | null }

// A version the person saved is approved as they saved it; see projectDocuments.approvedAt.
export async function applyDocumentChange(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  target: DocumentTarget,
  content: string,
  by: ChangeAuthor,
): Promise<DocumentVersion> {
  await lockTarget(db, projectId, target, '')
  const [latest] = await db
    .select({ content: projectDocuments.content })
    .from(projectDocuments)
    .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.slug, target)))
    .orderBy(desc(projectDocuments.createdAt), desc(projectDocuments.id))
    .limit(1)
  const [doc] = await db
    .insert(projectDocuments)
    .values({ tenantId, projectId, slug: target, content, approvedAt: by.actor === 'user' ? new Date() : null })
    .returning({ id: projectDocuments.id, createdAt: projectDocuments.createdAt, approvedAt: projectDocuments.approvedAt })
  if (latest?.content !== content) await log(db, tenantId, projectId, [{ target, op: 'update', ...by }])
  return doc!
}

const utcDay = (at: Date): string => at.toISOString().slice(0, 10)

export type OptionArchival =
  | { day: string; actor: 'rule'; reason: RuleArchiveReason }
  | { day: string; actor: ChangeAuthor['actor']; reason: string | null }
  | { day: string; actor: null; reason: null }

const changeCols = {
  target: policyChanges.target,
  optionId: policyChanges.optionId,
  op: policyChanges.op,
  actor: policyChanges.actor,
  reason: policyChanges.reason,
  ruleReason: policyChanges.ruleReason,
  evidence: policyChanges.evidence,
  createdAt: policyChanges.createdAt,
}

export async function lastArchivals(db: Db, projectId: ProjectId, target: OptionTarget, optionIds: string[]): Promise<Map<string, OptionArchival>> {
  if (optionIds.length === 0) return new Map()
  const rows = await db
    .selectDistinctOn([policyChanges.optionId], changeCols)
    .from(policyChanges)
    .where(and(
      eq(policyChanges.projectId, projectId),
      eq(policyChanges.target, target),
      eq(policyChanges.op, 'archive'),
      inArray(policyChanges.optionId, optionIds),
    ))
    .orderBy(policyChanges.optionId, desc(policyChanges.createdAt), desc(policyChanges.id))
  return new Map(rows.map((r): [string, OptionArchival] => {
    const day = utcDay(r.createdAt)
    if (r.actor !== 'rule') return [r.optionId!, { day, actor: r.actor, reason: r.reason }]
    if (r.ruleReason === null) throw new Error(`Invariant: rule archive of ${r.optionId} without its reason`)
    return [r.optionId!, { day, actor: r.actor, reason: r.ruleReason }]
  }))
}

// Options the rule archived as lost and nobody has brought back.
export async function lostOptionIds(db: Db, projectId: ProjectId, target: OptionTarget): Promise<string[]> {
  const archived = target === 'variant'
    ? await db.select({ id: messageVariants.variantId }).from(messageVariants)
        .where(and(eq(messageVariants.projectId, projectId), isNotNull(messageVariants.archivedAt)))
    : await db.select({ id: discoveryStrategies.slug }).from(discoveryStrategies)
        .where(and(eq(discoveryStrategies.projectId, projectId), isNotNull(discoveryStrategies.archivedAt)))
  const archivals = await lastArchivals(db, projectId, target, archived.map((o) => o.id))
  return [...archivals].filter(([, a]) => a.actor === 'rule' && a.reason === 'lost').map(([id]) => id).sort()
}

// When each option last entered the active set.
export async function optionEntries(db: Db, projectId: ProjectId, target: OptionTarget): Promise<Map<string, Date>> {
  const rows = await db
    .select({ optionId: policyChanges.optionId, at: max(policyChanges.createdAt) })
    .from(policyChanges)
    .where(and(eq(policyChanges.projectId, projectId), eq(policyChanges.target, target), inArray(policyChanges.op, ['add', 'restore'])))
    .groupBy(policyChanges.optionId)
  return new Map(rows.flatMap((r) => (r.optionId === null || r.at === null ? [] : [[r.optionId, r.at] as const])))
}

// Newest first.
export async function listChanges(db: Db, projectId: ProjectId, since: Date): Promise<LoggedChange[]> {
  const rows = await db
    .select(changeCols)
    .from(policyChanges)
    .where(and(eq(policyChanges.projectId, projectId), gte(policyChanges.createdAt, since)))
    .orderBy(desc(policyChanges.createdAt), desc(policyChanges.id))
  return rows.map((r): LoggedChange => {
    const day = utcDay(r.createdAt)
    if (r.target === 'business' || r.target === 'sales_strategy') {
      if (r.actor === 'rule') throw new Error(`Invariant: rule change to ${r.target}`)
      return { day, actor: r.actor, target: r.target, reason: r.reason }
    }
    if (r.optionId === null) throw new Error(`Invariant: ${r.target} change row without an option`)
    if (r.actor !== 'rule') return { day, actor: r.actor, target: r.target, optionId: r.optionId, op: r.op, reason: r.reason }
    const rule = { day, actor: r.actor, target: r.target, optionId: r.optionId, evidence: r.evidence }
    if (r.op === 'restore') return { ...rule, op: r.op }
    if (r.op !== 'archive' || r.ruleReason === null) throw new Error(`Invariant: rule ${r.op} of ${r.optionId} without an archive reason`)
    return { ...rule, op: r.op, reason: r.ruleReason }
  })
}

export async function ruleChangesSince(db: Db, projectId: ProjectId, since: Date): Promise<LoggedRuleChange[]> {
  return (await listChanges(db, projectId, since)).filter((c): c is LoggedRuleChange => c.actor === 'rule')
}
