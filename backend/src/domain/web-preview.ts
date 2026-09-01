import { z } from 'zod'
import { localeSchema, type Locale } from './locale'
import { findLinkOrContact } from './public-text'

// Output contract of the onboarding web preview (URL -> ICP + first cold
// emails). Persisted verbatim in web_previews.result and served to the
// onboarding page, so changes here are wire-format changes.

export type WebPreviewSegment = {
  name: string
  who: string
  why: string
}

export type WebPreviewEmail = {
  segment: string
  // Recipient role at a typical company in the segment, never an invented person.
  to: string
  subject: string
  // Body only — the compliance footer is separate, mirroring real sends.
  body: string
}

export type WebPreviewResult = {
  company: { name: string; oneLiner: string }
  locale: Locale
  segments: WebPreviewSegment[]
  emails: WebPreviewEmail[]
  // The compliance footer real sends would append, built server-side.
  footer: string
  // True while the identity lines are placeholders / site-derived rather than
  // the workspace's own legal name + address.
  footerIsProvisional: boolean
}

// Deterministic mirrors of the email-guideline hard rules a hostile or sloppy
// page must not be able to talk the model out of: no links or contact handles
// (public-text.ts covers scheme-less and bare-domain forms too), no merge
// placeholders, no footer separator written into the body, three distinct
// segments.
const NO_PLACEHOLDERS = /\{\{|\{[A-Za-z_][A-Za-z0-9_ ]*\}/
const NO_FOOTER_SEPARATOR = /^---/m

const emailTextField = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => findLinkOrContact(v) === null, { message: 'must not contain links or contacts' })
    .refine((v) => !NO_PLACEHOLDERS.test(v), { message: 'must not contain placeholders' })

const distinctNames = (segments: { name: string }[]): boolean =>
  new Set(segments.map((s) => s.name.trim().toLowerCase())).size === segments.length

// What the model must return. The core fields fail loudly on garbage; only the
// legal-identity extras degrade silently (`.catch(null)`) — their fallback is a
// placeholder footer, which is benign.
export const webPreviewLlmOutputSchema = z.object({
  company: z.object({
    name: z.string().min(1).max(200),
    oneLiner: z.string().min(1).max(300),
  }),
  // Strict: it picks the compliance-footer language, so an invalid value must
  // fail the whole answer, not silently anglicize a Japanese site's footer.
  locale: localeSchema,
  legalName: z.string().min(1).max(300).nullable().catch(null),
  postalAddress: z.string().min(1).max(500).nullable().catch(null),
  segments: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        who: z.string().min(1).max(600),
        why: z.string().min(1).max(400),
      }),
    )
    .length(3)
    .refine(distinctNames, { message: 'segment names must be distinct' }),
  emails: z
    .array(
      z.object({
        segment: z.string().min(1).max(80),
        to: z.string().min(1).max(200),
        subject: emailTextField(200),
        body: emailTextField(4000).refine((v) => !NO_FOOTER_SEPARATOR.test(v), {
          message: 'must not contain a footer separator',
        }),
      }),
    )
    .length(3),
})
export type WebPreviewLlmOutput = z.infer<typeof webPreviewLlmOutputSchema>
