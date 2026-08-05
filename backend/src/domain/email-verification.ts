import { z } from 'zod'
import type { EmailDeliverability } from '../db/schema'

export const verifierStatusSchema = z
  .enum([
    'safe',
    'valid',
    'invalid',
    'disabled',
    'disposable',
    'inbox_full',
    'catch_all',
    'role_account',
    'spamtrap',
    'unknown',
  ])
  .catch('unknown')
export type VerifierStatus = z.infer<typeof verifierStatusSchema>

export const verifierResponseSchema = z.object({ status: verifierStatusSchema })

// Reoon consumes daily credits before the never-expiring instant credits, so
// their sum is the remaining capacity.
export const verifierBalanceSchema = z.object({
  remaining_daily_credits: z.number(),
  remaining_instant_credits: z.number(),
})

// catch_all and role_account held live mailboxes in the prod ground-truth sample
// and inbox_full is a mailbox that exists, so blocking them would cost more leads
// than the bounces it saves.
const BLOCKING: ReadonlySet<VerifierStatus> = new Set<VerifierStatus>(['invalid', 'disabled'])

export function verifierDeliverabilityVerdict(status: VerifierStatus): EmailDeliverability {
  return BLOCKING.has(status) ? 'undeliverable' : 'unknown'
}
