import { z } from 'zod'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { projectSendingIdentities, sendingIdentities, type SendingIdentityProvider } from '../db/schema'
import { asSendingIdentityId, sendingIdentityIdSchema, type ProjectId, type ProjectRef, type SendingIdentityId, type TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import {
  DEFAULT_WARMUP,
  mailboxBounceWindow,
  mailboxDailyStatus,
  pickFromMailboxPool,
  type MailboxBounceWindow,
  type MailboxDailyStatus,
  type MailboxSendRefusal,
} from '../domain/warmup'
import {
  countMailboxBounceWindowByIdentity,
  countMailboxEmailSendsTodayByIdentity,
  type MailboxDailyQuota,
} from './plan-limits'

export type ProjectMailboxRow = {
  identityId: SendingIdentityId
  provider: SendingIdentityProvider
  fromEmail: string
  scope: string | null
  warmupStartedAt: Date | null
  dailyCapOverride: number | null
  pausedUntil: Date | null
  sendRefusal: MailboxSendRefusal | null
  authRevokedAt: Date | null
  pollFailingSince: Date | null
  lastPollError: string | null
  lastPolledAt: Date | null
}

const mailboxColumns = {
  identityId: sendingIdentities.identityId,
  provider: sendingIdentities.provider,
  fromEmail: sendingIdentities.fromEmail,
  scope: sendingIdentities.scope,
  warmupStartedAt: sendingIdentities.warmupStartedAt,
  dailyCapOverride: sendingIdentities.dailyCapOverride,
  pausedUntil: sendingIdentities.pausedUntil,
  sendRefusal: sendingIdentities.sendRefusal,
  authRevokedAt: sendingIdentities.authRevokedAt,
  pollFailingSince: sendingIdentities.pollFailingSince,
  lastPollError: sendingIdentities.lastPollError,
  lastPolledAt: sendingIdentities.lastPolledAt,
} as const

// The project's mailboxes in priority order; with none listed, the tenant's
// connected Gmail (a revoked one included, so its state can still be reported).
export async function loadProjectMailboxes(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ProjectMailboxRow[]> {
  const listed = await db
    .select(mailboxColumns)
    .from(projectSendingIdentities)
    .innerJoin(
      sendingIdentities,
      and(
        eq(sendingIdentities.tenantId, projectSendingIdentities.tenantId),
        eq(sendingIdentities.identityId, projectSendingIdentities.identityId),
      ),
    )
    .where(and(eq(projectSendingIdentities.tenantId, tenantId), eq(projectSendingIdentities.projectId, projectId)))
    .orderBy(asc(projectSendingIdentities.position))
  const rows =
    listed.length > 0
      ? listed
      : await db
          .select(mailboxColumns)
          .from(sendingIdentities)
          .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.provider, 'gmail_oauth')))
          .orderBy(sql`${sendingIdentities.authRevokedAt} IS NULL DESC`, asc(sendingIdentities.grantedAt))
          .limit(1)
  return rows.map((r) => ({ ...r, identityId: asSendingIdentityId(r.identityId) }))
}

async function withDailyStatus(
  db: Db,
  tenantId: TenantId,
  rows: ProjectMailboxRow[],
  now: Date,
): Promise<Array<ProjectMailboxRow & MailboxDailyStatus>> {
  const usedByIdentity = await countMailboxEmailSendsTodayByIdentity(db, tenantId, now)
  return rows.map((r) => ({ ...r, ...mailboxDailyStatus(r, usedByIdentity.get(r.identityId) ?? 0, DEFAULT_WARMUP, now) }))
}

const canSend = (m: { authRevokedAt: Date | null }) => m.authRevokedAt === null

// The mailbox the next email send uses: the first in priority order with sends left today.
export async function pickProjectMailbox(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  now: Date = new Date(),
): Promise<MailboxDailyQuota> {
  const rows = (await loadProjectMailboxes(db, tenantId, projectId)).filter(canSend)
  if (rows.length === 0) return { kind: 'no_mailbox' }
  return pickFromMailboxPool(await withDailyStatus(db, tenantId, rows, now))
}

// A send logged after the fact names no mailbox: it is attributed to the
// project's first listed one, the mailbox the project "sends from".
export async function firstProjectMailboxId(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<SendingIdentityId | null> {
  const [first] = (await loadProjectMailboxes(db, tenantId, projectId)).filter(canSend)
  return first?.identityId ?? null
}

export async function listProjectMailboxIds(db: Db, tenantId: TenantId, projectId: ProjectId): Promise<SendingIdentityId[]> {
  const rows = await db
    .select({ identityId: projectSendingIdentities.identityId })
    .from(projectSendingIdentities)
    .where(and(eq(projectSendingIdentities.tenantId, tenantId), eq(projectSendingIdentities.projectId, projectId)))
    .orderBy(asc(projectSendingIdentities.position))
  return rows.map((r) => asSendingIdentityId(r.identityId))
}

export const replaceProjectMailboxesSchema = z
  .object({
    // Priority order; empty = the connected Gmail.
    identityIds: z
      .array(sendingIdentityIdSchema)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'identityIds must not repeat' }),
  })
  .strict()
export type ReplaceProjectMailboxesInput = z.infer<typeof replaceProjectMailboxesSchema>

export async function replaceProjectMailboxes(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  input: ReplaceProjectMailboxesInput,
): Promise<ServiceResult<{ sendingIdentityIds: SendingIdentityId[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  if (input.identityIds.length > 0) {
    const known = await db
      .select({ identityId: sendingIdentities.identityId })
      .from(sendingIdentities)
      .where(and(eq(sendingIdentities.tenantId, tenantId), inArray(sendingIdentities.identityId, input.identityIds)))
    const knownIds = new Set(known.map((k) => k.identityId))
    const unknown = input.identityIds.filter((id) => !knownIds.has(id))
    if (unknown.length > 0) {
      return err('INVALID_INPUT', 'Unknown sending identity', `No sending identity ${unknown.join(', ')} for this tenant.`)
    }
  }

  // Serialize replacements per project: two overlapping delete + insert pairs
  // would otherwise collide on the position unique or leave a merged list.
  await db.execute(sql`SELECT 1 FROM projects WHERE id = ${projectId} AND tenant_id = ${tenantId} FOR UPDATE`)
  await db
    .delete(projectSendingIdentities)
    .where(and(eq(projectSendingIdentities.tenantId, tenantId), eq(projectSendingIdentities.projectId, projectId)))
  if (input.identityIds.length > 0) {
    await db.insert(projectSendingIdentities).values(
      input.identityIds.map((identityId, position) => ({ projectId, tenantId, identityId, position })),
    )
  }
  return ok({ sendingIdentityIds: await listProjectMailboxIds(db, tenantId, projectId) })
}

export type ProjectMailboxEntryHealth = ProjectMailboxRow & MailboxDailyStatus & MailboxBounceWindow

export type ProjectMailboxHealth =
  | { kind: 'no_mailbox' }
  | {
      kind: 'active'
      // Totals over the mailboxes able to send; `next` is the address the next
      // send uses, null when every one is spent, paused, held or revoked.
      cap: number
      used: number
      remaining: number
      next: string | null
      // Priority order, a revoked Gmail included so its state is visible.
      mailboxes: ProjectMailboxEntryHealth[]
    }

export async function getProjectMailboxHealth(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  now: Date = new Date(),
): Promise<ServiceResult<ProjectMailboxHealth>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const rows = await loadProjectMailboxes(db, tenantId, resolved.value)
  if (rows.length === 0) return ok({ kind: 'no_mailbox' })
  const [withStatus, bounceByIdentity] = await Promise.all([
    withDailyStatus(db, tenantId, rows, now),
    countMailboxBounceWindowByIdentity(db, tenantId, now),
  ])
  const mailboxes = withStatus.map((m) => ({ ...m, ...mailboxBounceWindow(bounceByIdentity.get(m.identityId)) }))
  const pick = pickFromMailboxPool(mailboxes.filter(canSend))
  const next = pick.kind === 'ready' ? mailboxes.find((m) => m.identityId === pick.identityId) : undefined
  return ok({ kind: 'active', cap: pick.cap, used: pick.used, remaining: pick.remaining, next: next?.fromEmail ?? null, mailboxes })
}
