import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { tenants } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { takeChatRateSlot, NOTIFICATIONS_PER_TENANT_PER_DAY } from './chat-rate-limit'
import { sendNotificationEmail, type GoogleCtx } from './google-auth'
import { ok, err, type ServiceResult } from './result'

export const notifyUserSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
})
export type NotifyUserInput = z.infer<typeof notifyUserSchema>

export type NotifyUserResult = { delivered: true } | { delivered: false; reason: 'not_configured' }

// The recipient is never caller-supplied: it is the tenant's notification
// address, so the brain can trigger a notification but cannot aim it.
export async function notifyUser(
  db: Db,
  tenantId: TenantId,
  userId: string,
  ctx: GoogleCtx,
  input: NotifyUserInput,
): Promise<ServiceResult<NotifyUserResult>> {
  const [row] = await db
    .select({ notificationEmail: tenants.notificationEmail })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!row) return err('INTERNAL_ERROR', 'Tenant row missing')
  if (row.notificationEmail === null) return ok({ delivered: false, reason: 'not_configured' })

  // Abuse ceiling on a Gmail-backed sender: a runaway loop must not burn the
  // mailbox's daily send quota that outreach depends on.
  const slot = await takeChatRateSlot(db, tenantId, 'notification', tenantId)
  if (!slot) {
    return err(
      'RATE_LIMITED',
      'Notification limit reached',
      `At most ${NOTIFICATIONS_PER_TENANT_PER_DAY} notifications per day per workspace.`,
    )
  }

  const sent = await sendNotificationEmail(db, tenantId, userId, ctx, {
    to: row.notificationEmail,
    subject: input.subject,
    body: input.body,
  })
  if (!sent.ok) return sent
  return ok({ delivered: true })
}
