// Country handling for outreach send guardrail and organization / prospect
// bootstrap. Pure functions: ccTLD inference and the allowlist gate.
//
// Send-target allowlist currently covers US + CA + JP. Anything else is
// blocked at the outreach send paths so users cannot accidentally send into
// a jurisdiction whose compliance rules we do not yet implement (UK PECR,
// AU Spam Act, EU GDPR/ePrivacy, etc.). JP is covered by the same footer
// block as US/CA — sender identity + opt-out satisfy Japan's anti-spam
// act (特定電子メール法); the disclosure required by the Act on
// Specified Commercial Transactions (特商法) is carried on /legal.

// Unmapped ccTLDs return null; callers fall back to LLM / manual input.
const TLD_TO_COUNTRY: Record<string, string> = {
  us: 'US',
  ca: 'CA',
  jp: 'JP',
  cn: 'CN',
  kr: 'KR',
  hk: 'HK',
  tw: 'TW',
  sg: 'SG',
  in: 'IN',
  au: 'AU',
  nz: 'NZ',
  uk: 'GB',
  gb: 'GB',
  de: 'DE',
  fr: 'FR',
  it: 'IT',
  es: 'ES',
  nl: 'NL',
  be: 'BE',
  se: 'SE',
  no: 'NO',
  dk: 'DK',
  fi: 'FI',
  ie: 'IE',
  pt: 'PT',
  pl: 'PL',
  ch: 'CH',
  at: 'AT',
  br: 'BR',
  mx: 'MX',
  ar: 'AR',
  cl: 'CL',
  il: 'IL',
  ae: 'AE',
  za: 'ZA',
}

// Generic TLDs that carry no country signal. Listed explicitly so a future
// reader sees we considered them rather than just falling through.
const GENERIC_TLDS = new Set([
  'com', 'org', 'net', 'io', 'ai', 'app', 'dev', 'co', 'biz', 'info',
  'tech', 'cloud', 'xyz', 'me',
])

export type CountryInferenceResult =
  | { country: string; source: 'tld_inferred' }
  | null

export function inferCountryFromDomain(apexDomain: string): CountryInferenceResult {
  const cleaned = apexDomain.trim().toLowerCase().replace(/^www\./, '')
  const lastDot = cleaned.lastIndexOf('.')
  if (lastDot === -1) return null
  const tld = cleaned.slice(lastDot + 1)
  if (GENERIC_TLDS.has(tld)) return null
  const country = TLD_TO_COUNTRY[tld]
  if (!country) return null
  return { country, source: 'tld_inferred' }
}

// Narrow until per-jurisdiction compliance rules ship.
export const ALLOWED_SEND_COUNTRIES = ['US', 'CA', 'JP'] as const
export type AllowedSendCountry = (typeof ALLOWED_SEND_COUNTRIES)[number]

export type SendCountryGate =
  | { allowed: true; reason: 'allowed' | 'unknown_warn' }
  | { allowed: false; reason: 'unsupported_country'; country: string }

// `null` country is treated as warn-only: we do not have enough information
// to determine the recipient's jurisdiction, but we let the send proceed.
// The caller logs the warn so it surfaces in observability.
export function isAllowedSendCountry(country: string | null | undefined): SendCountryGate {
  if (!country) return { allowed: true, reason: 'unknown_warn' }
  const upper = country.toUpperCase()
  if ((ALLOWED_SEND_COUNTRIES as readonly string[]).includes(upper)) return { allowed: true, reason: 'allowed' }
  return { allowed: false, reason: 'unsupported_country', country: upper }
}

const COUNTRY_CATALOG: { code: string; name: string }[] = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'JP', name: 'Japan' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AT', name: 'Austria' },
  { code: 'AU', name: 'Australia' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BR', name: 'Brazil' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China' },
  { code: 'DE', name: 'Germany' },
  { code: 'DK', name: 'Denmark' },
  { code: 'ES', name: 'Spain' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IN', name: 'India' },
  { code: 'IT', name: 'Italy' },
  { code: 'KR', name: 'South Korea' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'SE', name: 'Sweden' },
  { code: 'SG', name: 'Singapore' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'ZA', name: 'South Africa' },
]

export type CountryCodeEntry = { code: string; name: string; sendAllowed: boolean }

export type CountryCodeReference = {
  countries: CountryCodeEntry[]
  sendAllowed: string[]
  note: string
}

export function buildCountryCodeReference(): CountryCodeReference {
  const allowed = new Set<string>(ALLOWED_SEND_COUNTRIES)
  return {
    countries: COUNTRY_CATALOG.map((c) => ({ ...c, sendAllowed: allowed.has(c.code) })),
    sendAllowed: [...ALLOWED_SEND_COUNTRIES],
    note: 'Any two-letter code can be stored on a prospect or organization country field (validated by format, not catalog membership). Outreach currently delivers only to the sendAllowed countries; codes outside that set register fine but are blocked at outreach send time.',
  }
}
