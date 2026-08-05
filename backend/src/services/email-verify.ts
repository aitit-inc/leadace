import * as Sentry from '@sentry/cloudflare'
import {
  verifierBalanceSchema,
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
      // 429 is transient burst throttling (fail-open already covers it); other
      // statuses (401 revoked key, 5xx) must page the operator, so they stay error.
      Sentry.captureMessage(
        `email verifier rejected the request (${res.status}) — mailbox unchecked`,
        res.status === 429 ? 'warning' : 'error',
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

const BALANCE_URL = 'https://emailverifier.reoon.com/api/v1/check-account-balance'
// ~3 days of runway at the current ~30 verifications/day
const LOW_BALANCE_THRESHOLD = 100

// Rejected key / unreadable response = the watch is dead until someone acts, so
// they page as error; a network blip on a daily probe does not.
export async function watchVerifierBalance(apiKey: string | null): Promise<void> {
  if (!apiKey) return
  try {
    const res = await fetch(`${BALANCE_URL}?key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!res.ok) {
      Sentry.captureMessage(`email verifier balance check rejected (${res.status})`, 'error')
      console.warn(`[deliverability] balance check rejected (${res.status})`)
      return
    }
    const parsed = verifierBalanceSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success) {
      Sentry.captureMessage('email verifier balance response unreadable', 'error')
      console.warn('[deliverability] balance response unreadable')
      return
    }
    const { remaining_daily_credits: daily, remaining_instant_credits: instant } = parsed.data
    console.log(`[scheduled] verifier balance daily=${daily} instant=${instant}`)
    if (daily + instant < LOW_BALANCE_THRESHOLD) {
      Sentry.captureMessage('email verifier balance low — mailbox checks about to stop', 'error')
    }
  } catch (e) {
    Sentry.captureMessage('email verifier balance check unreachable', 'warning')
    console.warn(
      `[deliverability] balance check unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
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
