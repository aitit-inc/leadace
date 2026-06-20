import type { Locale } from './locale'

// Recipient-facing compliance footer lines. Localized by the recipient's
// locale so a Japanese prospect reads a Japanese footer (the legal name and
// physical address above them stay verbatim — they are proper nouns).

export function inquiryFooterLine(inquiryUrl: string, locale: Locale): string {
  return locale === 'ja'
    ? `詳細・ご質問・配信停止はこちら: ${inquiryUrl}`
    : `Learn more, ask anything, or unsubscribe: ${inquiryUrl}`
}

export function unsubscribeFooterLine(unsubscribeUrl: string, locale: Locale): string {
  return locale === 'ja' ? `配信停止: ${unsubscribeUrl}` : `Unsubscribe: ${unsubscribeUrl}`
}

export function privacyFooterLine(privacyPolicyUrl: string, locale: Locale): string {
  return locale === 'ja'
    ? `プライバシーポリシー: ${privacyPolicyUrl}`
    : `Privacy: ${privacyPolicyUrl}`
}
