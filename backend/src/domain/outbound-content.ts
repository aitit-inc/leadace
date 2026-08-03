// The machine-decidable half of the outbound-message bar. These rules cost a
// send when broken (a placeholder reaches a real inbox, a shared-app-domain
// link tanks deliverability, the recipient bypasses the inquiry landing) and
// have a single right answer, so they hold here rather than in prompt prose.
// Judgment-shaped rules — tone, relevance, whether a third-party link earns its
// deliverability cost — stay in the email guidelines.

import type { InquiryCtaType } from '../db/schema'
import type { Locale } from './locale'

export type ContentViolation =
  | { kind: 'placeholder'; field: 'subject' | 'body'; sample: string }
  | { kind: 'forbidden_link'; needle: string; reason: ForbiddenLinkReason }
  | { kind: 'footer_in_body'; part: 'physical_address' | 'separator' }
  | { kind: 'body_too_long'; measured: number; limit: number; unit: LengthUnit }
  | { kind: 'near_duplicate'; priorOutreachId: number; similarity: number }

export type ForbiddenLinkReason = 'own_host' | 'signup_cta' | 'cta_with_inquiry_landing'
export type LengthUnit = 'words' | 'characters'

// Bounded, no nested quantifiers: the body is model-generated, and a pathological
// input must not be able to stall a send path.
// The square-bracket form excludes a following `(` so a markdown link is not
// reported as a placeholder — it is a link problem, judged by the link rules.
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\{[^{}\n]{1,60}\}\}/,
  /\{[^{}\n]{1,60}\}/,
  /\[[A-Za-z][A-Za-z0-9 ._'-]{0,40}\](?!\()/,
]

function findPlaceholder(text: string): string | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

// Generous ceilings — roughly twice the length the guidelines target — so only a
// categorically broken body is refused and a slightly-over one still ships.
// Japanese has no word delimiter, so it is measured in non-whitespace characters.
const BODY_CEILING: Record<Locale, { limit: number; unit: LengthUnit }> = {
  en: { limit: 220, unit: 'words' },
  ja: { limit: 700, unit: 'characters' },
}

function measureBody(text: string, unit: LengthUnit): number {
  if (unit === 'words') {
    const trimmed = text.trim()
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length
  }
  return [...text.replace(/\s+/g, '')].length
}

// Substring rather than URL parsing: a scheme-less `app.example.com/x` is still
// auto-linkified by every mail client, so the host has to be absent outright.
function hostNeedle(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// Only a CTA URL carrying a path is checkable. A bare-host one (`https://acme.com`)
// is indistinguishable from the sender naming their own domain in prose, and
// refusing that would cost a legitimate send.
function ctaNeedle(url: string): string | null {
  const stripped = url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return stripped.includes('/') ? stripped : null
}

// The footer is appended by the send path; the model writing its own duplicates
// the legal disclosure and doubles the separator.
const FOOTER_SEPARATOR = '---'

function hasFooterSeparator(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === FOOTER_SEPARATOR)
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export type OutboundContentInput = {
  subject: string | null
  body: string
  targetLanguage: Locale
  appUrl: string
  apiUrl: string
  inquiryCtaType: InquiryCtaType
  inquiryCtaUrl: string | null
  inquiryLandingEnabled: boolean
  physicalAddress: string
}

export function checkOutboundContent(input: OutboundContentInput): ContentViolation[] {
  const violations: ContentViolation[] = []

  const subjectPlaceholder = input.subject === null ? null : findPlaceholder(input.subject)
  if (subjectPlaceholder !== null) {
    violations.push({ kind: 'placeholder', field: 'subject', sample: subjectPlaceholder })
  }
  const bodyPlaceholder = findPlaceholder(input.body)
  if (bodyPlaceholder !== null) {
    violations.push({ kind: 'placeholder', field: 'body', sample: bodyPlaceholder })
  }

  const haystack = input.body.toLowerCase()
  for (const url of [input.appUrl, input.apiUrl]) {
    const host = hostNeedle(url)
    if (host !== null && haystack.includes(host)) {
      violations.push({ kind: 'forbidden_link', needle: host, reason: 'own_host' })
    }
  }

  // Signup: inlining the URL skips the landing page, so `signup_clicked` is never
  // recorded and the recipient stays re-eligible for outbound. Meeting: the
  // scheduling link is allowed inline only when there is no landing URL competing
  // with it.
  const ctaUrl = input.inquiryCtaUrl === null ? null : ctaNeedle(input.inquiryCtaUrl)
  if (ctaUrl !== null) {
    const reason: ForbiddenLinkReason | null =
      input.inquiryCtaType === 'signup'
        ? 'signup_cta'
        : input.inquiryLandingEnabled
          ? 'cta_with_inquiry_landing'
          : null
    if (reason !== null && haystack.includes(ctaUrl)) {
      violations.push({ kind: 'forbidden_link', needle: ctaUrl, reason })
    }
  }

  const address = collapseWhitespace(input.physicalAddress)
  if (address.length >= 8 && collapseWhitespace(input.body).includes(address)) {
    violations.push({ kind: 'footer_in_body', part: 'physical_address' })
  }
  if (hasFooterSeparator(input.body)) {
    violations.push({ kind: 'footer_in_body', part: 'separator' })
  }

  const ceiling = BODY_CEILING[input.targetLanguage]
  const measured = measureBody(input.body, ceiling.unit)
  if (measured > ceiling.limit) {
    violations.push({ kind: 'body_too_long', measured, limit: ceiling.limit, unit: ceiling.unit })
  }

  return violations
}

// Gmail spam-clusters by content similarity, so one flagged body poisons every
// similar future send. Character shingles keep the measure language-agnostic.
//
// Measured on realistic cold bodies (en + ja): identical 1.00, name swapped 0.79–0.97,
// template with every slot swapped 0.74–0.76, same frame with the middle rewritten
// 0.26, unrelated messages in the same house style 0.01–0.02. The threshold sits in
// the empty band between the last two, so slot-swapped templating is refused and
// genuine per-recipient writing is not.
export const NEAR_DUPLICATE_THRESHOLD = 0.5
const SHINGLE_SIZE = 5

// Stored bodies for form / SNS drafts already carry the appended footer, which is
// near-constant per tenant and would inflate every comparison.
export function stripAppendedFooter(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === FOOTER_SEPARATOR) return lines.slice(0, i).join('\n')
  }
  return text
}

export function normalizeForSimilarity(text: string): string {
  return stripAppendedFooter(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, '')
}

function shingles(normalized: string): Set<string> {
  const chars = [...normalized]
  if (chars.length === 0) return new Set()
  if (chars.length <= SHINGLE_SIZE) return new Set([normalized])
  const set = new Set<string>()
  for (let i = 0; i + SHINGLE_SIZE <= chars.length; i++) {
    set.add(chars.slice(i, i + SHINGLE_SIZE).join(''))
  }
  return set
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const gram of a) {
    if (b.has(gram)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

export function contentSimilarity(a: string, b: string): number {
  return jaccard(shingles(normalizeForSimilarity(a)), shingles(normalizeForSimilarity(b)))
}

export type PriorBody = { id: number; body: string }

export function findNearDuplicate(
  body: string,
  priors: readonly PriorBody[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
): { priorOutreachId: number; similarity: number } | null {
  const candidate = shingles(normalizeForSimilarity(body))
  let worst: { priorOutreachId: number; similarity: number } | null = null
  for (const prior of priors) {
    const similarity = jaccard(candidate, shingles(normalizeForSimilarity(prior.body)))
    if (similarity >= threshold && (worst === null || similarity > worst.similarity)) {
      worst = { priorOutreachId: prior.id, similarity }
    }
  }
  return worst
}

function describeForbiddenLink(needle: string, reason: ForbiddenLinkReason): string {
  switch (reason) {
    case 'own_host':
      return `The body links to "${needle}". Our own domain is the strongest spam signal we have measured; the backend appends the only link this message may carry.`
    case 'signup_cta':
      return `The body contains the signup URL ("${needle}"). Inlining it lets the recipient bypass the inquiry landing page, so the click is never recorded — invite them to reply or to the landing conversation instead.`
    case 'cta_with_inquiry_landing':
      return `The body contains the scheduling URL ("${needle}") while inquiry landing is on. The backend-appended landing URL is the only link this message may carry.`
  }
}

function describeViolation(violation: ContentViolation): string {
  switch (violation.kind) {
    case 'placeholder':
      return `The ${violation.field} still contains an unfilled placeholder ("${violation.sample}"). Write the real value, or reword the sentence without it.`
    case 'forbidden_link':
      return describeForbiddenLink(violation.needle, violation.reason)
    case 'footer_in_body':
      return violation.part === 'physical_address'
        ? 'The body repeats the legal postal address. Legal disclosures come from the backend-appended footer — remove them from the body.'
        : 'The body contains a "---" separator line, which duplicates the backend-appended footer separator. Remove it.'
    case 'body_too_long':
      return `The body is ${violation.measured} ${violation.unit} (hard limit ${violation.limit}). Cut everything that is not about the recipient or one concrete point about the offer.`
    case 'near_duplicate':
      return `The body is ${Math.round(violation.similarity * 100)}% identical to outreach #${violation.priorOutreachId}. Vary the opener, structure, paragraph order and CTA — a re-used body poisons every similar future send.`
  }
}

export function describeContentViolations(violations: readonly ContentViolation[]): string {
  return violations.map(describeViolation).join(' ')
}
