import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ACCOUNT_DELETION_REASONS,
  accountDeletionSurveys,
  tenantPlans,
} from '../db/schema'
import { createDb, type Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { deleteTenantAttachments } from './chat/attachments'
import { revokeUserFamilies } from './mcp-sessions'
import { ok, err, type ServiceResult } from './result'
import { stripeApiRequest } from './stripe-api'

export const accountDeletionSurveySchema = z
  .object({
    reason: z.enum(ACCOUNT_DELETION_REASONS),
    detail: z.string().trim().max(500).optional(),
  })
  .refine((s) => s.reason !== 'other' || (s.detail?.length ?? 0) > 0, {
    message: 'detail is required when reason is "other"',
    path: ['detail'],
  })
export type AccountDeletionSurvey = z.infer<typeof accountDeletionSurveySchema>

// resource_missing means an earlier delete attempt already canceled the
// subscription, so a non-ok cancel carrying that code is still tolerable.
export function isStripeCancelTolerable(
  result: { ok: boolean; data: Record<string, unknown> },
): boolean {
  if (result.ok) return true
  const stripeErr = result.data['error'] as { code?: string } | undefined
  return stripeErr?.code === 'resource_missing'
}

export type DeleteAccountConfig = {
  databaseUrl: string
  stripeKey: string | null
  mcpOauthStore: KVNamespace
  attachments: R2Bucket
}

// Stripe first so a billing failure doesn't leave the user paying for a deleted
// account. auth.users goes through the raw connection (app_rls can't reach the
// auth schema); its AFTER DELETE trigger deletes the tenant in the same transaction.
export async function deleteOwnAccount(
  cfg: DeleteAccountConfig,
  rlsDb: Db,
  tenantId: TenantId,
  userId: string,
  survey: AccountDeletionSurvey,
): Promise<ServiceResult<undefined>> {
  if (cfg.stripeKey) {
    const [plan] = await rlsDb
      .select({ stripeSubscriptionId: tenantPlans.stripeSubscriptionId })
      .from(tenantPlans)
      .where(eq(tenantPlans.tenantId, tenantId))
      .limit(1)

    if (plan?.stripeSubscriptionId) {
      const cancel = await stripeApiRequest(
        'DELETE',
        `/subscriptions/${plan.stripeSubscriptionId}`,
        null,
        cfg.stripeKey,
      )
      if (!isStripeCancelTolerable(cancel)) {
        return err('BAD_GATEWAY', 'Failed to cancel Stripe subscription', cancel.data)
      }
    }
  }

  const adminDb = createDb(cfg.databaseUrl)
  const deleted = await adminDb.execute(
    sql`DELETE FROM auth.users WHERE id = ${userId}::uuid RETURNING id`,
  )
  if (deleted.length === 0) {
    return err('NOT_FOUND', 'Account not found')
  }

  // Swallowed: the deletion is already irreversible, so analytics must not fail it.
  try {
    await adminDb.insert(accountDeletionSurveys).values({
      reason: survey.reason,
      detail: survey.reason === 'other' ? (survey.detail ?? null) : null,
    })
  } catch (e) {
    console.error('account-deletion: survey insert failed', e)
  }

  // Best-effort: a plugin left configured would otherwise keep refreshing its
  // MCP token for up to 30 days.
  try {
    await revokeUserFamilies(cfg.mcpOauthStore, userId)
  } catch (e) {
    console.error('account-deletion: MCP session revoke failed', { userId, e })
  }

  // The chat's attachments live in the bucket, which no cascade reaches.
  try {
    await deleteTenantAttachments(cfg.attachments, tenantId)
  } catch (e) {
    console.error('account-deletion: attachment delete failed', { tenantId, e })
  }

  return ok(undefined)
}
