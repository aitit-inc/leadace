import { and, eq, gt, sql } from 'drizzle-orm'
import { chatRateWindows, type ChatRateScope } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { startOfTodayUtc } from './plan-limits'

export const INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY = 15
export const PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY = 100
export const NOTIFICATIONS_PER_TENANT_PER_DAY = 100
export const WEB_PREVIEWS_PER_TENANT_PER_DAY = 5
// Hosted chat agent turns (one person message = one slot); the tool calls a
// turn makes are bounded separately by the agent loop.
export const MAIN_CHAT_TURNS_PER_TENANT_PER_DAY = 300
// URL → strategy drafts (onboarding); each reads a site through Gemini.
export const STRATEGY_DRAFTS_PER_TENANT_PER_DAY = 10

const LIMITS: Record<ChatRateScope, number> = {
  inquiry_link: INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY,
  preview: PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY,
  notification: NOTIFICATIONS_PER_TENANT_PER_DAY,
  web_preview: WEB_PREVIEWS_PER_TENANT_PER_DAY,
  main_chat: MAIN_CHAT_TURNS_PER_TENANT_PER_DAY,
  strategy_draft: STRATEGY_DRAFTS_PER_TENANT_PER_DAY,
}

// Reserve-first: call immediately before the LLM spend, so a concurrent burst
// can never exceed the window's limit in OpenAI calls. Slots are deliberately
// not refunded on downstream failure (abuse ceiling, not billing); the one
// exception is releaseChatRateSlot below.
export async function takeChatRateSlot(
  db: Db,
  tenantId: TenantId,
  scope: ChatRateScope,
  key: string,
): Promise<boolean> {
  const [row] = await db
    .insert(chatRateWindows)
    .values({ tenantId, scope, key, windowStart: startOfTodayUtc(), used: 1 })
    .onConflictDoUpdate({
      target: [
        chatRateWindows.tenantId,
        chatRateWindows.scope,
        chatRateWindows.key,
        chatRateWindows.windowStart,
      ],
      set: { used: sql`${chatRateWindows.used} + 1` },
      setWhere: sql`${chatRateWindows.used} < ${LIMITS[scope]}`,
    })
    .returning({ used: chatRateWindows.used })
  return row !== undefined
}

// Hands a reserved slot back. Only for a failure that is the input's fault
// rather than a spend (the web preview's "site could not be read"), so a typo
// does not lock a new tenant out for the rest of the UTC day.
export async function releaseChatRateSlot(
  db: Db,
  tenantId: TenantId,
  scope: ChatRateScope,
  key: string,
): Promise<void> {
  await db
    .update(chatRateWindows)
    .set({ used: sql`${chatRateWindows.used} - 1` })
    .where(
      and(
        eq(chatRateWindows.tenantId, tenantId),
        eq(chatRateWindows.scope, scope),
        eq(chatRateWindows.key, key),
        eq(chatRateWindows.windowStart, startOfTodayUtc()),
        gt(chatRateWindows.used, 0),
      ),
    )
}
