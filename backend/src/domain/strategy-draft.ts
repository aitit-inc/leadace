// A project's first setup — what the chat agent writes from the material a
// person shared and applyStrategyDraft saves in one call. Lives in domain so
// the tool registry and the service share one definition.
import { z } from 'zod'
import { OUTBOUND_CHANNELS } from './outbound-channel'
import { discoveryStrategySchema, variantIdSchema } from './ids'
import { localeSchema } from './locale'
import { isPublicHttpsUrl, isPublicWebUrl } from './url'

const publicHttpsUrl = z.url().max(500).refine((u) => isPublicHttpsUrl(u) && isPublicWebUrl(u), { message: 'must be a public https:// URL' })

export const readPagesSchema = z.object({ urls: z.array(publicHttpsUrl).min(1).max(5) })
export const competitorsInputSchema = z.object({ url: publicHttpsUrl })

export const applyStrategyDraftSchema = z.object({
  targetLanguage: localeSchema,
  // Full markdown documents following tpl_business / tpl_sales_strategy.
  business: z.string().min(1),
  salesStrategy: z.string().min(1),
  discoveryStrategies: z.array(z.object({ slug: discoveryStrategySchema, approach: z.string().min(1).max(2000) })).min(3).max(6),
  messageVariants: z
    .array(z.object({ variantId: variantIdSchema, subjectPattern: z.string().min(1).max(80), bodyApproach: z.string().min(1).max(2000), label: z.string().min(1).max(120) }))
    .length(4),
  inquiryChatBrief: z.string().min(1).max(4000),
  inquiryOneLiner: z.string().min(1).max(140),
  outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).min(1),
})
export type ApplyStrategyDraftInput = z.infer<typeof applyStrategyDraftSchema>
