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

const VERIFY_URL = 'https://api.emailable.com/v1/verify'
// Measured 0.25-0.8s from CF egress (2026-08-12/13 gate probes). The send
// holds its RLS transaction open for the wait, so it is capped rather than
// awaited out; the vendor-side timeout stays below the client abort so a slow
// SMTP conversation surfaces as a parsed HTTP 249 instead of an aborted fetch.
const VERIFY_TIMEOUT_MS = 8_000
// Emailable accepts 2-10 seconds.
const VENDOR_TIMEOUT_SECONDS = 6

export type SendTimeVerdict =
  | { deliverability: 'unknown'; mailboxAnswered: boolean }
  | { deliverability: 'undeliverable'; reason: string; mailboxAnswered: boolean }

type MailboxProbeOutcome = { answered: true; status: VerifierStatus } | { answered: false }

// Failure bodies carry the diagnosis (MillionVerifier died silently for a day
// because only the HTTP status was visible), but success-shaped bodies echo
// the probed address — so only the vendor's `message` field is ever logged.
function vendorMessage(raw: string): string {
  try {
    const message: unknown = (JSON.parse(raw) as { message?: unknown }).message
    return typeof message === 'string' ? message.slice(0, 120) : '(no message)'
  } catch {
    return '(unparseable body)'
  }
}

// `answered: false` blocks nothing, so an outage or a revoked key is silent unless
// reported. Sentry messages stay fixed strings — the URL would leak address + key.
async function probeMailbox(email: string, apiKey: string): Promise<MailboxProbeOutcome> {
  try {
    const res = await fetch(
      `${VERIFY_URL}?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=${VENDOR_TIMEOUT_SECONDS}`,
      { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
    )
    // 249 sits in the 2xx range (res.ok), so it must be handled before the
    // rejection branch. It is the vendor's documented slow-SMTP outcome, not a
    // fault, so it never pages — fail-open covers it.
    if (res.status === 249) {
      console.warn('[deliverability] verifier still verifying (249) — mailbox unchecked')
      return { answered: false }
    }
    if (!res.ok) {
      // 429 is transient burst throttling (fail-open already covers it); other
      // statuses (403 revoked key, 402 out of credits, 5xx) must page the
      // operator, so they stay error.
      Sentry.captureMessage(
        `email verifier rejected the request (${res.status}) — mailbox unchecked`,
        res.status === 429 ? 'warning' : 'error',
      )
      console.warn(
        `[deliverability] verifier rejected the request (${res.status}): ${vendorMessage(await res.text().catch(() => ''))} — mailbox unchecked`,
      )
      return { answered: false }
    }
    const raw = await res.text().catch(() => '')
    const parsed = verifierResponseSchema.safeParse(
      (() => {
        try {
          return JSON.parse(raw) as unknown
        } catch {
          return null
        }
      })(),
    )
    if (!parsed.success) {
      Sentry.captureMessage('email verifier response unreadable — mailbox unchecked', 'warning')
      console.warn(
        `[deliverability] verifier response unreadable: ${vendorMessage(raw)} — mailbox unchecked`,
      )
      return { answered: false }
    }
    return { answered: true, status: parsed.data.state }
  } catch (e) {
    Sentry.captureMessage('email verifier unreachable or unreadable — mailbox unchecked', 'warning')
    console.warn(
      `[deliverability] verifier unreachable or unreadable: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { answered: false }
  }
}

const BALANCE_URL = 'https://api.emailable.com/v1/account'
// ~3 days of runway at the current ~30 verifications/day
const LOW_BALANCE_THRESHOLD = 100

// Rejected key / unreadable response = the watch is dead until someone acts, so
// they page as error; a network blip on a daily probe does not.
export async function watchVerifierBalance(apiKey: string | null): Promise<void> {
  if (!apiKey) return
  try {
    const res = await fetch(`${BALANCE_URL}?api_key=${encodeURIComponent(apiKey)}`, {
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
    const credits = parsed.data.available_credits
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
    console.warn('[deliverability] EMAILABLE_API_KEY is not set — mailbox unchecked')
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
