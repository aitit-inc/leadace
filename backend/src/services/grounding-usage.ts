import { eq, sql } from 'drizzle-orm'
import { groundingUsage } from '../db/schema'
import type { Db } from '../db/connection'

// Grounding with Google Search: 5,000 queries a month free per API project,
// $14 per 1,000 beyond.
export const GROUNDING_FREE_QUERIES_PER_MONTH = 5_000

export function groundingQuotaWarning(queries: number): string {
  if (queries >= GROUNDING_FREE_QUERIES_PER_MONTH) return '  ⚠️ free quota used up — $14 / 1k queries from here'
  if (queries >= GROUNDING_FREE_QUERIES_PER_MONTH * 0.8) return '  ⚠️ near the free quota'
  return ''
}

export function groundingMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7)
}

export async function recordGroundingQueries(db: Db, searchQueries: number, now: Date): Promise<void> {
  await db
    .insert(groundingUsage)
    .values({ month: groundingMonthKey(now), searchQueries })
    .onConflictDoUpdate({
      target: groundingUsage.month,
      set: { searchQueries: sql`${groundingUsage.searchQueries} + ${searchQueries}` },
    })
}

export async function readGroundingQueries(db: Db, now: Date): Promise<number> {
  const [row] = await db
    .select({ searchQueries: groundingUsage.searchQueries })
    .from(groundingUsage)
    .where(eq(groundingUsage.month, groundingMonthKey(now)))
  return row?.searchQueries ?? 0
}
