import type { JobOrigin } from './jobs'

// 'cron' is what ran unattended (a schedule and the jobs it started); 'lead'
// is a recipient asking for a conversation on the inquiry page; the rest is 'general'.
export const NOTIFICATION_CATEGORIES = ['general', 'cron', 'lead'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

// What notify_user may file under: the agent reports runs, and a lead is only
// ever the inquiry page's to announce.
export const AGENT_NOTIFICATION_CATEGORIES = ['general', 'cron'] as const satisfies readonly NotificationCategory[]

// The bell shows this many; older ones are dropped.
export const NOTIFICATIONS_KEPT = 30

export function categoryOfJob(startedBy: JobOrigin): NotificationCategory {
  return startedBy === 'cron' ? 'cron' : 'general'
}
