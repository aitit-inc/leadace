// The first setup LeadAce proposes from a company website — the data the
// chat agent shows for review and applyStrategyDraft writes. Lives in domain
// so the tool registry and the service share one definition.
import { z } from 'zod'
import { OUTBOUND_CHANNELS } from './outbound-channel'
import { discoveryStrategySchema, variantIdSchema } from './ids'
import { localeSchema } from './locale'
import { isPublicHttpsUrl } from './url'

export const strategyDraftInputSchema = z.object({
  url: z.url().max(500).refine(isPublicHttpsUrl, { message: 'must be a public https:// URL' }),
})
export type StrategyDraftInput = z.infer<typeof strategyDraftInputSchema>

const nullableText = (max: number) => z.string().max(max).nullable()

export const strategyDraftSchema = z.object({
  projectName: z.string().min(1).max(80),
  targetLanguage: localeSchema,
  company: z.object({ name: z.string().min(1).max(200), oneLiner: z.string().min(1).max(300) }),
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
  // Values that render into every recipient's footer / landing; the person
  // enters them in the Web UI — the draft only reports what the site shows.
  uiHandoff: z.object({
    legalName: nullableText(200),
    postalAddress: nullableText(500),
    senderCountry: z.string().regex(/^[A-Z]{2}$/).nullable(),
    senderCompanyName: nullableText(200),
    phone: nullableText(60),
    schedulingUrl: nullableText(500),
    signupUrl: nullableText(500),
    videoUrl: nullableText(500),
    pdfUrl: nullableText(500),
  }),
})
export type StrategyDraft = z.infer<typeof strategyDraftSchema>

// The approved proposal minus what the Web UI owns (uiHandoff).
export const applyStrategyDraftSchema = strategyDraftSchema.omit({ uiHandoff: true, projectName: true, company: true })
export type ApplyStrategyDraftInput = z.infer<typeof applyStrategyDraftSchema>

