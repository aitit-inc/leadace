import type { EmailDeliverability } from '../db/schema'

export const UNDELIVERABLE = 'undeliverable' satisfies EmailDeliverability

// Re-guard before the DoH step so a malformed address never triggers a lookup.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export function isEmailSyntaxValid(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? ''
}

// RFC 2606 / 6761 reserved names that can never resolve. Treated as 'unknown'
// (not 'undeliverable') so test/example fixtures aren't dropped by the gate.
const RESERVED_NAMES = [
  'test',
  'example',
  'invalid',
  'localhost',
  'example.com',
  'example.net',
  'example.org',
] as const
export function isReservedDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase()
  if (!d) return false
  return RESERVED_NAMES.some((r) => d === r || d.endsWith(`.${r}`))
}

// The signal picker filters in SQL, where the predicate above cannot run.
// Deriving from the same list is what keeps the two spellings from drifting.
export const RESERVED_NAME_SQL_PATTERN = `(^|\\.)(${RESERVED_NAMES.map((r) =>
  r.replace(/\./g, '\\.'),
).join('|')})$`

export type DomainRecords = { mx: string[]; a: string[]; aaaa: string[] }

// RFC 5321: no MX → A/AAAA acts as an implicit MX. RFC 7505: a sole null-MX
// record ("0 .") means the domain accepts no mail.
export function domainCanReceiveMail(r: DomainRecords): boolean {
  const mx = r.mx.map((s) => s.trim()).filter(Boolean)
  if (mx.length > 0) {
    const onlyMx = mx[0]
    if (mx.length === 1 && onlyMx !== undefined && isNullMx(onlyMx)) return false
    return true
  }
  return r.a.length > 0 || r.aaaa.length > 0
}

function isNullMx(record: string): boolean {
  // DoH MX data form: "<priority> <host>"; null-MX is "0 .".
  const [priority, host] = record.split(/\s+/)
  return priority === '0' && (host === undefined || host === '' || host === '.')
}

// Fail open: an incomplete DoH lookup yields 'unknown', never 'undeliverable'.
export function dnsDeliverabilityVerdict(args: {
  syntaxValid: boolean
  dnsResolved: boolean
  canReceiveMail: boolean
}): EmailDeliverability {
  if (!args.syntaxValid) return 'undeliverable'
  if (!args.dnsResolved) return 'unknown'
  return args.canReceiveMail ? 'unknown' : 'undeliverable'
}
