import type { Locale } from './locale'

// Phrasing rotates per prospect so the footer isn't a byte-identical cross-tenant
// signature for Gmail's spam-similarity clustering. The legal opt-out is the
// List-Unsubscribe header, so varying the wording never weakens compliance.

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

const UNSUBSCRIBE_VARIANTS: Record<Locale, readonly string[]> = {
  en: ['Unsubscribe', 'Opt out here', 'To unsubscribe', 'Stop receiving these'],
  ja: ['配信停止', '配信停止はこちら', '今後の配信を停止', 'メール配信の停止'],
}

const PRIVACY_VARIANTS: Record<Locale, readonly string[]> = {
  en: ['Privacy', 'Privacy policy', 'Our privacy policy'],
  ja: ['プライバシーポリシー', '個人情報の取り扱い', 'プライバシー'],
}

function pickVariant(variants: readonly string[], seed: number): string {
  const i = Math.abs(Math.trunc(seed)) % variants.length
  return variants[i] ?? variants[0] ?? ''
}

export function inquiryFooterLine(inquiryUrl: string, locale: Locale, seed: number): string {
  return `${pickVariant(INQUIRY_VARIANTS[locale], seed)}: ${inquiryUrl}`
}

export function unsubscribeFooterLine(
  unsubscribeUrl: string,
  locale: Locale,
  seed: number,
): string {
  return `${pickVariant(UNSUBSCRIBE_VARIANTS[locale], seed)}: ${unsubscribeUrl}`
}

export function privacyFooterLine(
  privacyPolicyUrl: string,
  locale: Locale,
  seed: number,
): string {
  return `${pickVariant(PRIVACY_VARIANTS[locale], seed)}: ${privacyPolicyUrl}`
}
