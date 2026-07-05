import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { inquiryTokens, outreachLogs } from '../db/schema'
import { generateInquiryShortId } from '../auth/inquiry-token'
import type { Db } from '../db/connection'
import {
  outreachLogIdSchema,
  type ShortId,
  type TenantId,
  asShortId,
  asTenantId,
} from '../domain/ids'
import { ok, err, type ServiceResult } from './result'

// `shortIdSchema` in domain bakes in INQUIRY_SHORT_ID_PATTERN, so a single
// boundary parser owns the brand-with-format invariant.
export { shortIdParamSchema as inquiryShortIdParamSchema } from '../domain/ids'

export const createInquiryTokenBodySchema = z.object({
  outreachLogId: outreachLogIdSchema,
})
export type CreateInquiryTokenInput = z.infer<typeof createInquiryTokenBodySchema>

export type InquiryTokenRow = {
  shortId: ShortId
  tenantId: TenantId
  prospectId: number
  outreachLogId: number
  createdAt: Date
  revokedAt: Date | null
}

const MAX_INSERT_RETRIES = 3

export type CreatedInquiryToken = {
  shortId: ShortId
  inquiryUrl: string
}

function buildInquiryUrl(appUrl: string, shortId: ShortId): string {
  return `${appUrl}/q/${shortId}`
}

// Idempotent on (outreach_log_id) for live tokens — keeps URLs stable across
// retried sends. Revoked rows are kept; re-issuance allocates a new short_id.
// `appUrl` is a parameter so the service stays HTTP/runtime-agnostic.
export async function createInquiryToken(
  db: Db,
  tenantId: TenantId,
  appUrl: string,
  input: CreateInquiryTokenInput,
): Promise<ServiceResult<CreatedInquiryToken>> {
  const [log] = await db
    .select({
      id: outreachLogs.id,
      prospectId: outreachLogs.prospectId,
    })
    .from(outreachLogs)
    .where(
      and(eq(outreachLogs.id, input.outreachLogId), eq(outreachLogs.tenantId, tenantId)),
    )
    .limit(1)

  if (!log) return err('NOT_FOUND', 'Outreach log not found')

  const [existing] = await db
    .select({ shortId: inquiryTokens.shortId })
    .from(inquiryTokens)
    .where(
      and(
        eq(inquiryTokens.outreachLogId, input.outreachLogId),
        isNull(inquiryTokens.revokedAt),
      ),
    )
    .limit(1)
  if (existing) {
    const branded = asShortId(existing.shortId)
    return ok({ shortId: branded, inquiryUrl: buildInquiryUrl(appUrl, branded) })
  }

  // PK collision is astronomically rare at 64^8; the retry loop only exists
  // to avoid surfacing the theoretical race as a 500.
  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    const shortId = asShortId(generateInquiryShortId())
    try {
      await db.insert(inquiryTokens).values({
        shortId,
        tenantId,
        prospectId: log.prospectId,
        outreachLogId: log.id,
      })
      return ok({ shortId, inquiryUrl: buildInquiryUrl(appUrl, shortId) })
    } catch (e) {
      if (isUniqueViolation(e) && attempt < MAX_INSERT_RETRIES - 1) continue
      throw e
    }
  }

  return err('INTERNAL_ERROR', 'Failed to allocate inquiry short_id')
}

// NOT_FOUND from createInquiryToken is deliberately swallowed — the caller
// still has the outreach row, the footer just won't include an inquiry line.
export async function allocateInquiryUrl(
  db: Db,
  tenantId: TenantId,
  appUrl: string,
  outreachLogId: number,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null
  const result = await createInquiryToken(db, tenantId, appUrl, { outreachLogId })
  return result.ok ? result.value.inquiryUrl : null
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === '23505'
  )
}

// Conflates "no such token" and "revoked" into a single null return — the
// distinction would leak short_id existence to scanners.
export async function resolveInquiryToken(
  db: Db,
  shortId: ShortId,
): Promise<InquiryTokenRow | null> {
  const [row] = await db
    .select()
    .from(inquiryTokens)
    .where(and(eq(inquiryTokens.shortId, shortId), isNull(inquiryTokens.revokedAt)))
    .limit(1)
  return row
    ? {
        ...row,
        shortId: asShortId(row.shortId),
        tenantId: asTenantId(row.tenantId),
        prospectId: row.prospectId,
        outreachLogId: row.outreachLogId,
      }
    : null
}

export async function revokeInquiryToken(
  db: Db,
  tenantId: TenantId,
  shortId: ShortId,
): Promise<ServiceResult<{ revoked: true }>> {
  const [row] = await db
    .update(inquiryTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(inquiryTokens.shortId, shortId),
        eq(inquiryTokens.tenantId, tenantId),
        isNull(inquiryTokens.revokedAt),
      ),
    )
    .returning({ shortId: inquiryTokens.shortId })

  if (!row) return err('NOT_FOUND', 'Inquiry token not found or already revoked')
  return ok({ revoked: true })
}
