import { z } from 'zod'

// Supported recipient-facing locales: the per-project outbound-message
// language (an explicit setting, never derived from a country) and the
// client-reported page language on the public inquiry / unsubscribe pages.
export const localeSchema = z.enum(['en', 'ja'])
export type Locale = z.infer<typeof localeSchema>
