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

const VERIFY_URL = 'https://api.millionverifier.com/api/v3/'
// Measured 0.3-3.9s (2026-08-12, from both residential and CF egress). The send
// holds its RLS transaction open for the wait, so it is capped rather than
// awaited out; the vendor-side timeout stays below the client abort so a slow
// SMTP conversation surfaces as a parsed 'unknown' instead of an aborted fetch.
const VERIFY_TIMEOUT_MS = 8_000
const VENDOR_TIMEOUT_SECONDS = 6

export type SendTimeVerdict =
  | { deliverability: 'unknown'; mailboxAnswered: boolean }
  | { deliverability: 'undeliverable'; reason: string; mailboxAnswered: boolean }

type MailboxProbeOutcome = { answered: true; status: VerifierStatus } | { answered: false }

// `answered: false` blocks nothing, so an outage or a revoked key is silent unless
// reported. Sentry messages stay fixed strings — the URL would leak address + key.
async function probeMailbox(email: string, apiKey: string): Promise<MailboxProbeOutcome> {
  try {
    const res = await fetch(
      `${VERIFY_URL}?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=${VENDOR_TIMEOUT_SECONDS}`,
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
      return { answered: false }
    }
    const parsed = verifierResponseSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success) {
      Sentry.captureMessage('email verifier response unreadable — mailbox unchecked', 'warning')
      console.warn('[deliverability] verifier response unreadable — mailbox unchecked')
      return { answered: false }
    }
    const status = parsed.data.result
    // The vendor's 'error' result reports a failed verification, not a verdict —
    // treated like a transport failure so it never stamps the verdict store.
    if (status === 'error') {
      console.warn('[deliverability] verifier returned error — mailbox unchecked')
      return { answered: false }
    }
    return { answered: true, status }
  } catch (e) {
    Sentry.captureMessage('email verifier unreachable or unreadable — mailbox unchecked', 'warning')
    console.warn(
      `[deliverability] verifier unreachable or unreadable: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { answered: false }
  }
}

const BALANCE_URL = 'https://api.millionverifier.com/api/v3/credits'
// ~3 days of runway at the current ~30 verifications/day
const LOW_BALANCE_THRESHOLD = 100

// Rejected key / unreadable response = the watch is dead until someone acts, so
// they page as error; a network blip on a daily probe does not.
export async function watchVerifierBalance(apiKey: string | null): Promise<void> {
  if (!apiKey) return
  try {
    const res = await fetch(`${BALANCE_URL}?api=${encodeURIComponent(apiKey)}`, {
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
    const { credits } = parsed.data
    console.log(`[scheduled] verifier balance credits=${credits}`)
    if (credits < LOW_BALANCE_THRESHOLD) {
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
  opts: { skipMailboxProbe: boolean },
): Promise<SendTimeVerdict> {
  if (isReservedDomain(domainOf(email))) {
    return { deliverability: 'unknown', mailboxAnswered: false }
  }

  // Separate from the DNS verdict, which collapses both causes: `reason` reaches a
  // 422 and the log, so it must not name a cause this has not established.
  if (!isEmailSyntaxValid(email)) {
    return { deliverability: UNDELIVERABLE, reason: 'malformed address', mailboxAnswered: false }
  }

  // DNS re-resolves on every send regardless of the stored verdict — it is
  // free, fast, and catches domains that died after the mailbox probe.
  const dns = (await resolveEmailDeliverability([email])).get(email)
  if (dns === UNDELIVERABLE) {
    return {
      deliverability: UNDELIVERABLE,
      reason: 'domain does not accept mail',
      mailboxAnswered: false,
    }
  }
  if (opts.skipMailboxProbe) return { deliverability: 'unknown', mailboxAnswered: false }
  if (!apiKey) {
    console.warn('[deliverability] MILLION_VERIFIER_API_KEY is not set — mailbox unchecked')
    return { deliverability: 'unknown', mailboxAnswered: false }
  }

  const outcome = await probeMailbox(email, apiKey)
  if (!outcome.answered) return { deliverability: 'unknown', mailboxAnswered: false }
  if (verifierDeliverabilityVerdict(outcome.status) !== UNDELIVERABLE) {
    return { deliverability: 'unknown', mailboxAnswered: true }
  }
  return {
    deliverability: UNDELIVERABLE,
    reason: `mailbox ${outcome.status}`,
    mailboxAnswered: true,
  }
}
