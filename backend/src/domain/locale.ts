// Recipient-facing language for the parts a prospect actually reads: the email
// compliance footer, the inquiry landing page, and the inquiry chat. This is
// NOT app-wide i18n — the operator-facing LeadAce UI stays English. The switch
// is automatic: a Japanese recipient (effective country JP) gets Japanese,
// everyone else English. Effective country is the prospect override falling
// back to the organization, the same precedence the send guardrail uses.
export type Locale = 'ja' | 'en'

export function localeForCountry(country: string | null | undefined): Locale {
  return country?.toUpperCase() === 'JP' ? 'ja' : 'en'
}
