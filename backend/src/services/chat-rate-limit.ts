import { and, eq, sql } from 'drizzle-orm'
import { chatRateWindows, type ChatRateScope } from '../db/schema'
import type { Db } from '../db/connection'
import { creditsCoverOverage, USAGE_PRICE_CENTS } from '../domain/credits'
import type { Edition } from '../domain/edition'
import type { TenantId } from '../domain/ids'
import { debitChatMessage } from './credits'
import { ok, err, type ServiceResult } from './result'
import {
  buildMainChatQuota,
  formatMainChatLimitError,
  getTenantPlan,
  mainChatWindow,
  startOfTodayUtc,
  sumCreditBalance,
  type MainChatQuota,
  type TenantPlan,
} from './plan-limits'

export const INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY = 15
export const PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY = 100
export const NOTIFICATIONS_PER_TENANT_PER_DAY = 100
// Hosted chat agent turns (one person message = one slot); the tool calls a
// turn makes are bounded separately by the agent loop.
export const MAIN_CHAT_TURNS_PER_TENANT_PER_DAY = 300
// Chat attachments: each one is stored and handed to the provider, whether or
// not the message carrying it is ever sent.
export const ATTACHMENT_UPLOADS_PER_TENANT_PER_DAY = 100
// Requests to read pages (up to five each) or search competitors for a setup.
// The chat agent is bounded by its turns; this bounds the routes called directly.
export const SETUP_READS_PER_TENANT_PER_DAY = 60

type DailyScope = Exclude<ChatRateScope, 'main_chat_allowance'>

const LIMITS: Record<DailyScope, number> = {
  inquiry_link: INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY,
  preview: PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY,
  notification: NOTIFICATIONS_PER_TENANT_PER_DAY,
  main_chat: MAIN_CHAT_TURNS_PER_TENANT_PER_DAY,
  attachment_upload: ATTACHMENT_UPLOADS_PER_TENANT_PER_DAY,
  setup_read: SETUP_READS_PER_TENANT_PER_DAY,
}

// Reserve-first: call immediately before the LLM spend, so a concurrent burst
// can never exceed the window's limit in OpenAI calls. Slots are deliberately
// not refunded on downstream failure (abuse ceiling, not billing).
export function takeChatRateSlot(db: Db, tenantId: TenantId, scope: DailyScope, key: string): Promise<boolean> {
  return takeSlot(db, tenantId, scope, key, startOfTodayUtc(), LIMITS[scope])
}

async function takeSlot(
  db: Db,
  tenantId: TenantId,
  scope: ChatRateScope,
  key: string,
  windowStart: Date,
  limit: number,
): Promise<boolean> {
  const [row] = await db
    .insert(chatRateWindows)
    .values({ tenantId, scope, key, windowStart, used: 1 })
    .onConflictDoUpdate({
      target: [
        chatRateWindows.tenantId,
        chatRateWindows.scope,
        chatRateWindows.key,
        chatRateWindows.windowStart,
      ],
      set: { used: sql`${chatRateWindows.used} + 1` },
      setWhere: sql`${chatRateWindows.used} < ${limit}`,
    })
    .returning({ used: chatRateWindows.used })
  return row !== undefined
}

// Counted here, not from chat_messages, which a deleted thread takes with it.
// Past the allowance a paid plan pays from its credits; the tenant lock makes
// the balance read and the debit one step, so the balance never goes negative.
// The window keeps counting, and the count names the ledger row.
export async function takeMainChatMessage(db: Db, tenantId: TenantId, edition: Edition): Promise<ServiceResult<undefined>> {
  const tp = await getTenantPlan(db, tenantId, edition)
  const w = mainChatWindow(tp)
  if (!w) return ok(undefined)
  if (await takeSlot(db, tenantId, 'main_chat_allowance', tenantId, w.start, w.messages)) return ok(undefined)
  const refused = err('FORBIDDEN', 'Chat message limit reached', formatMainChatLimitError(tp.plan, w))
  if (!tp.autoTopUp) return refused
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`)
  const balanceCents = await sumCreditBalance(db, tenantId)
  if (!creditsCoverOverage({ balanceCents, autoTopUp: tp.autoTopUp }, USAGE_PRICE_CENTS.chat)) return refused
  const [row] = await db
    .update(chatRateWindows)
    .set({ used: sql`${chatRateWindows.used} + 1` })
    .where(mainChatWindowRow(tenantId, w.start))
    .returning({ used: chatRateWindows.used })
  if (!row) throw new Error('main chat window row missing past its allowance')
  await debitChatMessage(db, tenantId, w.start, row.used)
  return ok(undefined)
}

function mainChatWindowRow(tenantId: TenantId, start: Date) {
  return and(
    eq(chatRateWindows.tenantId, tenantId),
    eq(chatRateWindows.scope, 'main_chat_allowance'),
    eq(chatRateWindows.key, tenantId),
    eq(chatRateWindows.windowStart, start),
  )
}

export async function getMainChatQuota(db: Db, tenantId: TenantId, tp: TenantPlan): Promise<MainChatQuota> {
  const w = mainChatWindow(tp)
  if (!w) return { kind: 'unlimited' }
  const [row] = await db
    .select({ used: chatRateWindows.used })
    .from(chatRateWindows)
    .where(mainChatWindowRow(tenantId, w.start))
  return buildMainChatQuota(w, row?.used ?? 0)
}
