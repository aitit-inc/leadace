import { sql } from 'drizzle-orm'
import { chatRateWindows, type ChatRateScope } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { startOfTodayUtc } from './plan-limits'

export const INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY = 15
export const PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY = 100

const LIMITS: Record<ChatRateScope, number> = {
  inquiry_link: INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY,
  preview: PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY,
}

// Reserve-first: call immediately before the LLM spend, so a concurrent burst
// can never exceed the window's limit in OpenAI calls. Slots are deliberately
// not refunded on downstream failure (abuse ceiling, not billing).
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
