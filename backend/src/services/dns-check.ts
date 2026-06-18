import { and, eq, inArray, ne } from 'drizzle-orm'
import {
  isEmailSyntaxValid,
  domainOf,
  domainCanReceiveMail,
  dnsDeliverabilityVerdict,
  isReservedDomain,
  UNDELIVERABLE,
  type DomainRecords,
} from '../domain/email-deliverability'
import { createDb } from '../db/connection'
import { prospects, type EmailDeliverability } from '../db/schema'
import type { TenantId } from '../domain/ids'

// Workers cannot open raw DNS sockets. dns.google is used over cloudflare-dns.com,
// which can loop when called from a Worker.
const DOH_URL = 'https://dns.google/resolve'
const DOH_TIMEOUT_MS = 2000

const RECORD_TYPE = { MX: 15, A: 1, AAAA: 28 } as const
type RecordType = keyof typeof RECORD_TYPE

type DohResponse = { Status: number; Answer?: Array<{ type: number; data: string }> }

// [] = conclusively no records, null = lookup failed (caller fails open).
async function query(name: string, type: RecordType): Promise<string[] | null> {
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as DohResponse
    // 3 = NXDOMAIN (definitively no records); non-zero otherwise = inconclusive.
    if (data.Status === 3) return []
    if (data.Status !== 0) return null
    const wanted = RECORD_TYPE[type]
    return (data.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data)
  } catch {
    return null
  }
}

// null when any required lookup is inconclusive, so the caller fails open. An MX
// alone proves mail-capability, so A/AAAA are only queried when there is no MX.
export async function resolveDomainRecords(domain: string): Promise<DomainRecords | null> {
  if (!domain) return null
  const mx = await query(domain, 'MX')
  if (mx === null) return null
  if (mx.length > 0) return { mx, a: [], aaaa: [] }
  const [a, aaaa] = await Promise.all([query(domain, 'A'), query(domain, 'AAAA')])
  if (a === null || aaaa === null) return null
  return { mx: [], a, aaaa }
}

const DNS_CHECK_CONCURRENCY = 20
// Bound distinct lookups so a huge import stays well under the Workers
// subrequest budget; domains beyond the cap fail open to 'unknown'.
//
// The cap also bounds wall time. The background stamp runs in ctx.waitUntil,
// which Cloudflare keeps alive for ~30s after the response returns; a stamp not
// settled by then is cancelled and the terminal UPDATE never lands. Worst case is
// ceil(MAX_DISTINCT_DOMAINS / DNS_CHECK_CONCURRENCY) sequential lanes, each domain
// costing up to 2 * DOH_TIMEOUT_MS (an MX timeout, then A+AAAA in parallel):
// ceil(100/20) * 2 * 2000ms = 20s, leaving margin under the keep-alive. Keep that
// product comfortably under ~25s if any of these three constants change.
const MAX_DISTINCT_DOMAINS = 100

// Per-email verdict, resolving each distinct domain once with bounded concurrency.
export async function resolveEmailDeliverability(
  emails: readonly string[],
): Promise<Map<string, EmailDeliverability>> {
  const verdicts = new Map<string, EmailDeliverability>()
  const domainOfEmail = new Map<string, string>()
  for (const email of new Set(emails)) {
    if (!isEmailSyntaxValid(email)) {
      verdicts.set(email, 'undeliverable')
      continue
    }
    const domain = domainOf(email)
    if (isReservedDomain(domain)) {
      verdicts.set(email, 'unknown')
      continue
    }
    domainOfEmail.set(email, domain)
  }

  const domains = Array.from(new Set(domainOfEmail.values())).slice(0, MAX_DISTINCT_DOMAINS)
  const records = new Map<string, DomainRecords | null>()
  let next = 0
  async function worker(): Promise<void> {
    while (next < domains.length) {
      const domain = domains[next++]
      if (domain === undefined) continue
      records.set(domain, await resolveDomainRecords(domain))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DNS_CHECK_CONCURRENCY, domains.length) }, () => worker()),
  )

  for (const [email, domain] of domainOfEmail) {
    const r = records.get(domain) // undefined when the domain was past the cap
    verdicts.set(
      email,
      dnsDeliverabilityVerdict({
        syntaxValid: true,
        dnsResolved: r !== null && r !== undefined,
        canReceiveMail: !!r && domainCanReceiveMail(r),
      }),
    )
  }
  return verdicts
}

// Background (ctx.waitUntil) stamp: resolve verdicts off the request path and
// persist only the addresses that prove undeliverable. Best-effort and
// fail-open — a failure here leaves rows 'unknown' (accepted). Uses createDb()
// (no request RLS txn in scope) and scopes the write by tenant_id.
export async function stampEmailDeliverability(
  databaseUrl: string,
  tenantId: TenantId,
  emails: readonly string[],
): Promise<void> {
  if (emails.length === 0) return
  try {
    const verdicts = await resolveEmailDeliverability(emails)
    const undeliverable = [...verdicts].filter(([, v]) => v === UNDELIVERABLE).map(([e]) => e)
    if (undeliverable.length === 0) return
    const db = createDb(databaseUrl)
    await db
      .update(prospects)
      .set({ emailDeliverability: UNDELIVERABLE })
      .where(
        and(
          eq(prospects.tenantId, tenantId),
          inArray(prospects.email, undeliverable),
          ne(prospects.emailDeliverability, UNDELIVERABLE),
        ),
      )
  } catch (e) {
    console.error('[deliverability] background stamp failed', e)
  }
}
