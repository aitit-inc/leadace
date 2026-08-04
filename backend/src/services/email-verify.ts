import * as Sentry from '@sentry/cloudflare'
import {
  verifierDeliverabilityVerdict,
  verifierResponseSchema,
  type VerifierStatus,
} from '../domain/email-verification'
import {
  UNDELIVERABLE,
  domainOf,
  isEmailSyntaxValid,
  isReservedDomain,
} from '../domain/email-deliverability'
import { resolveEmailDeliverability } from './dns-check'

const VERIFY_URL = 'https://emailverifier.reoon.com/api/v1/verify'
// Vendor documents "seconds to over a minute", measured 1.4-2.1s. The send holds
// its RLS transaction open for the wait, so it is capped rather than awaited out.
const VERIFY_TIMEOUT_MS = 8_000

export type SendTimeVerdict =
  | { deliverability: 'unknown' }
  | { deliverability: 'undeliverable'; reason: string }

// `unknown` blocks nothing, so an outage or a revoked key is silent unless
// reported. Sentry messages stay fixed strings — the URL would leak address + key.
async function probeMailbox(email: string, apiKey: string): Promise<VerifierStatus> {
  try {
    const res = await fetch(
      `${VERIFY_URL}?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`,
      { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
    )
    if (!res.ok) {
      Sentry.captureMessage(
        `email verifier rejected the request (${res.status}) — mailbox unchecked`,
        'error',
      )
      console.warn(`[deliverability] verifier rejected the request (${res.status}) — mailbox unchecked`)
      return 'unknown'
    }
    return verifierResponseSchema.parse(await res.json()).status
  } catch (e) {
    Sentry.captureMessage('email verifier unreachable or unreadable — mailbox unchecked', 'warning')
    console.warn(
      `[deliverability] verifier unreachable or unreadable: ${e instanceof Error ? e.message : String(e)}`,
    )
    return 'unknown'
  }
}

export async function verifyAddressBeforeSend(
  email: string,
  apiKey: string | null,
): Promise<SendTimeVerdict> {
  if (isReservedDomain(domainOf(email))) return { deliverability: 'unknown' }

  // Separate from the DNS verdict, which collapses both causes: `reason` reaches a
  // 422 and the log, so it must not name a cause this has not established.
  if (!isEmailSyntaxValid(email)) {
    return { deliverability: UNDELIVERABLE, reason: 'malformed address' }
  }

  const dns = (await resolveEmailDeliverability([email])).get(email)
  if (dns === UNDELIVERABLE) {
    return { deliverability: UNDELIVERABLE, reason: 'domain does not accept mail' }
  }
  if (!apiKey) {
    console.warn('[deliverability] REOON_API_KEY is not set — mailbox unchecked')
    return { deliverability: 'unknown' }
  }

  const status = await probeMailbox(email, apiKey)
  if (verifierDeliverabilityVerdict(status) !== UNDELIVERABLE) return { deliverability: 'unknown' }
  return { deliverability: UNDELIVERABLE, reason: `mailbox ${status}` }
}
