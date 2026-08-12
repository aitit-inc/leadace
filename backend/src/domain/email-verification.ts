import { z } from 'zod'
import type { EmailDeliverability } from '../db/schema'

// MillionVerifier single-verify (api/v3) result values.
const verifierStatusEnum = z.enum(['ok', 'catch_all', 'unknown', 'error', 'disposable', 'invalid'])

// Degrades unrecognised values for offline tooling. The live response schema
// below stays strict: an error-shaped payload (e.g. {error: "api_key_invalid"})
// or an unrecognised result is not an answer — the caller fails open without
// stamping the verdict store, instead of caching 'unknown' for the TTL.
export const verifierStatusSchema = verifierStatusEnum.catch('unknown')
export type VerifierStatus = z.infer<typeof verifierStatusSchema>

export const verifierResponseSchema = z.object({ result: verifierStatusEnum })

export const verifierBalanceSchema = z.object({ credits: z.number() })

// Addresses die on the week scale (prod: 4/56 bounces were domains that died
// after import), so a conclusive verifier answer stays trustworthy for weeks.
export const MAILBOX_VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function isMailboxVerdictFresh(verifiedAt: Date | null, now: Date): boolean {
  if (verifiedAt === null) return false
  return now.getTime() - verifiedAt.getTime() < MAILBOX_VERDICT_TTL_MS
}

// Only a provably dead mailbox blocks a send. catch_all mailboxes held live
// owners in the prod ground-truth sample, and disposable/role addresses do
// accept mail, so blocking them would cost more leads than the bounces they
// save. This exact rule scored 45% dead-blocked / 0 live false-blocked on the
// 2026-08-12 ground truth (dead 44 / live 11).
const BLOCKING: ReadonlySet<VerifierStatus> = new Set<VerifierStatus>(['invalid'])

export function verifierDeliverabilityVerdict(status: VerifierStatus): EmailDeliverability {
  return BLOCKING.has(status) ? 'undeliverable' : 'unknown'
}
