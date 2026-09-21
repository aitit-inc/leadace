import { z } from 'zod'
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { notifications, tenants } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantRun } from '../db/rls'
import type { TenantId } from '../domain/ids'
import { AGENT_NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORIES, NOTIFICATIONS_KEPT, type NotificationCategory } from '../domain/notifications'
import { takeChatRateSlot, NOTIFICATIONS_PER_TENANT_PER_DAY } from './chat-rate-limit'
import { sendNotificationEmail, type GoogleCtx } from './google-auth'
import { getTenantOwnerUserId } from './tenants'
import { ok, err, type ServiceResult } from './result'

export const notifyUserSchema = z.object({
  category: z.enum(AGENT_NOTIFICATION_CATEGORIES).default('general'),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
})
export type NotifyUserInput = z.infer<typeof notifyUserSchema>

export type Notice = {
  category: NotificationCategory
  // Names the event, so notifying it twice records and emails it once.
  reference: string
  subject: string
  body: string
  // An app path, e.g. /chat?t=…
  link: string
}

export type NotifyCtx = GoogleCtx & { appUrl: string }

export type NotifyEnv = {
  APP_URL: string
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  E2E_RECIPIENT_OVERRIDE?: string
}

export function notifyCtxOf(env: NotifyEnv): NotifyCtx {
  return {
    encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    e2eRecipientOverride: env.E2E_RECIPIENT_OVERRIDE ?? null,
    appUrl: env.APP_URL,
  }
}

// `recorded` is false when this call found the event already notified, so a
// caller that keeps its own cursor knows the report it built was not the one
// filed. `emailedTo` is null when the category's email switch is off.
export type NotifyResult = { recorded: boolean; emailedTo: string | null }

// Records the event for the bell and emails it when the category's switch is
// on. The recipient is never caller-supplied, so the brain cannot aim it. The
// record commits before the email goes out, so a rerun finds it and does not
// send again.
export async function notify(run: TenantRun, tenantId: TenantId, ctx: NotifyCtx, notice: Notice): Promise<ServiceResult<NotifyResult>> {
  const record = await run(async (db) => {
    const [inserted] = await db
      .insert(notifications)
      .values({ tenantId, ...notice })
      .onConflictDoNothing()
      .returning({ id: notifications.id })
    if (!inserted) return null
    const kept = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(NOTIFICATIONS_KEPT)
    await db.delete(notifications).where(and(eq(notifications.tenantId, tenantId), notInArray(notifications.id, kept)))
    const [row] = await db
      .select({
        to: tenants.notificationEmail,
        general: tenants.notifyGeneralEmail,
        cron: tenants.notifyCronEmail,
        lead: tenants.notifyLeadEmail,
        insight: tenants.notifyInsightEmail,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
    return { email: row?.[notice.category] ? { to: row.to } : null }
  })
  if (!record) return ok({ recorded: false, emailedTo: null })
  const email = record.email
  if (!email) return ok({ recorded: true, emailedTo: null })

  return run(async (db): Promise<ServiceResult<NotifyResult>> => {
    const owner = await getTenantOwnerUserId(db, tenantId)
    if (!owner) return err('INTERNAL_ERROR', 'Tenant has no owner')
    // Abuse ceiling on a Gmail-backed sender: a runaway loop must not burn the
    // mailbox's daily send quota that outreach depends on.
    const slot = await takeChatRateSlot(db, tenantId, 'notification', tenantId)
    if (!slot) {
      return err('RATE_LIMITED', 'Notification limit reached', `At most ${NOTIFICATIONS_PER_TENANT_PER_DAY} notification emails per day per workspace.`)
    }
    const sent = await sendNotificationEmail(db, tenantId, owner, ctx, {
      to: email.to,
      subject: notice.subject,
      body: `${notice.body}\n\n${ctx.appUrl}${notice.link}`,
    })
    if (!sent.ok) return sent
    return ok({ recorded: true, emailedTo: sent.value.to })
  })
}

export type NotificationItem = {
  id: number
  category: NotificationCategory
  subject: string
  body: string
  link: string
  createdAt: string
  unread: boolean
}

export async function listNotifications(db: Db, tenantId: TenantId): Promise<ServiceResult<NotificationItem[]>> {
  const [prefs] = await db
    .select({
      general: tenants.notifyGeneralInApp,
      cron: tenants.notifyCronInApp,
      lead: tenants.notifyLeadInApp,
      insight: tenants.notifyInsightInApp,
      seenAt: tenants.notificationsSeenAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!prefs) return err('INTERNAL_ERROR', 'Tenant row missing')
  const shown = NOTIFICATION_CATEGORIES.filter((c) => prefs[c])
  if (shown.length === 0) return ok([])
  const rows = await db
    .select({
      id: notifications.id,
      category: notifications.category,
      subject: notifications.subject,
      body: notifications.body,
      link: notifications.link,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), inArray(notifications.category, shown)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
  return ok(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), unread: r.createdAt > prefs.seenAt })))
}

export async function markNotificationsSeen(db: Db, tenantId: TenantId): Promise<ServiceResult<undefined>> {
  await db.update(tenants).set({ notificationsSeenAt: new Date() }).where(eq(tenants.id, tenantId))
  return ok(undefined)
}
