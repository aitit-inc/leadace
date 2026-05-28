import { z } from 'zod'
import { eq, and, gte, sql } from 'drizzle-orm'
import { bugReports, BUG_REPORT_CATEGORIES } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'

// Per-tenant per-day cap. Generous so a real burst of feedback doesn't get
// rate-limited, but bounded to keep accidental loops or spam from filling
// the table. Adjust if real usage justifies it.
const DAILY_CAP = 20

export const recordBugReportBodySchema = z
  .object({
    category: z.enum(BUG_REPORT_CATEGORIES),
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(10).max(4000),
    // Free-form metadata: skill name, plugin version, prospect/project ids,
    // anything the caller thinks helps reproduce. We don't constrain shape
    // so context can evolve without schema changes.
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export type RecordBugReportInput = z.infer<typeof recordBugReportBodySchema>

export async function recordBugReport(
  db: Db,
  tenantId: TenantId,
  userId: string,
  input: RecordBugReportInput,
): Promise<ServiceResult<{ id: number }>> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [count] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(bugReports)
    .where(and(eq(bugReports.tenantId, tenantId), gte(bugReports.createdAt, dayAgo)))

  if ((count?.n ?? 0) >= DAILY_CAP) {
    return err(
      'FORBIDDEN',
      `Daily bug-report cap reached (${DAILY_CAP}/day). Try again later.`,
    )
  }

  const [row] = await db
    .insert(bugReports)
    .values({
      tenantId,
      userId,
      category: input.category,
      title: input.title,
      body: input.body,
      context: input.context ?? null,
    })
    .returning({ id: bugReports.id })

  if (!row) return err('INTERNAL_ERROR', 'Failed to record bug report')
  return ok({ id: row.id })
}
