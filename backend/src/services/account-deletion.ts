import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  ACCOUNT_DELETION_REASONS,
  accountDeletionSurveys,
  tenantPlans,
  tenants,
} from '../db/schema'
import { createDb, type Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
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
  supabaseUrl: string
  // null on self-host installs that don't configure SUPABASE_SERVICE_ROLE_KEY.
  // The auth.users delete is skipped in that case; the operator handles it
  // against their own Supabase. tenant cascade still runs.
  adminKey: string | null
  stripeKey: string | null
  mcpOauthStore: KVNamespace
}

// Stripe cancel → DB cascade → auth.users delete. auth.users is best-effort
// last because its failure is recoverable (next login re-provisions a fresh
// empty tenant); Stripe is first so a billing failure doesn't leave the user
// paying for a DB that no longer exists.
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

  // Raw db (no RLS) so the cascade isn't gated on every child table's policy.
  const adminDb = createDb(cfg.databaseUrl)
  const deleted = await adminDb
    .delete(tenants)
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id })
  if (deleted.length === 0) {
    return err('NOT_FOUND', 'Tenant not found')
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

  // Best-effort like the auth.users delete below: a plugin left configured
  // would otherwise keep refreshing its MCP token for up to 30 days.
  try {
    await revokeUserFamilies(cfg.mcpOauthStore, userId)
  } catch (e) {
    console.error('account-deletion: MCP session revoke failed', { userId, e })
  }

  if (cfg.adminKey) {
    const res = await fetch(
      `${cfg.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${cfg.adminKey}`,
          apikey: cfg.adminKey,
        },
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('account-deletion: Supabase Admin delete failed', {
        userId,
        status: res.status,
        body,
      })
    }
  }

  return ok(undefined)
}
