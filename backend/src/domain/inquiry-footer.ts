import type { Locale } from './locale'

// Phrasing rotates per prospect so the footer isn't a byte-identical cross-tenant
// signature for Gmail's spam-similarity clustering. Every variant carries the
// legal opt-out itself, so varying the wording never weakens compliance.

const INQUIRY_VARIANTS: Record<Locale, readonly string[]> = {
  en: [
    'Learn more, ask anything, or unsubscribe',
    'Questions, more info, or opt out',
    'Reply, learn more, or unsubscribe',
    'More details — or unsubscribe',
  ],
  ja: [
    '詳細・ご質問・配信停止はこちら',
    'ご質問・詳細・配信停止はこちら',
    '詳細／ご質問／配信停止',
    '詳しい情報・配信停止はこちら',
  ],
}

const REPLY_UNSUBSCRIBE_VARIANTS: Record<Locale, readonly string[]> = {
  en: [
    'To unsubscribe, just reply to this email with “unsubscribe”.',
    'Don’t want these emails? Reply with “unsubscribe” and I’ll remove you.',
    'Reply “unsubscribe” to this email to opt out.',
  ],
  ja: [
    '配信停止をご希望の場合は、このメールに「配信停止」とご返信ください。',
    '今後の配信が不要な場合は「配信停止」とご返信ください。',
    '配信を停止するには、このメールに「配信停止」と返信してください。',
  ],
}

function pickVariant(variants: readonly string[], seed: number): string {
  const i = Math.abs(Math.trunc(seed)) % variants.length
  return variants[i] ?? variants[0] ?? ''
}

export function inquiryFooterLine(inquiryUrl: string, locale: Locale, seed: number): string {
  return `${pickVariant(INQUIRY_VARIANTS[locale], seed)}: ${inquiryUrl}`
}

export function replyUnsubscribeFooterLine(locale: Locale, seed: number): string {
  return pickVariant(REPLY_UNSUBSCRIBE_VARIANTS[locale], seed)
}

// Shared by send-time assembly and the settings default preview so they can't drift.
export function composeFooterBlock(lines: string[]): string {
  return `---\n${lines.join('\n')}`
}
