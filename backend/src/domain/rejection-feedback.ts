import { z } from 'zod'
import {
  REJECTION_PRIMARY_REASONS,
  REJECTION_RECONTACT_WINDOWS,
  type RejectionFeedbackV1,
  type RejectionPrimaryReason,
  type RejectionRecontactWindow,
  type responseTypeEnum,
} from '../db/schema'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]

// Decision-maker referral payload embedded in rejectionFeedback. Shared by
// both the wire schema (Zod) and the service-level helpers that materialise
// it into a prospect row.
export type DecisionMakerPointer = {
  name?: string
  email?: string
  role?: string
}

// Consent flag triplet used by every wire shape that accepts an unsubscribe
// reason — services/responses.ts (rejectionFeedbackSchema), unsubscribe.ts
// (withReasonBodySchema), inquiry-session.ts (inquiryUnsubscribeBodySchema).
export const rejectionConsentSchema = z.object({
  gdpr_erasure_request: z.boolean().optional(),
  ccpa_opt_out: z.boolean().optional(),
  marketing_opt_out: z.boolean().optional(),
})

// Five-field opt-in subset shared by the full RejectionFeedbackV1 wire schema
// (services/responses.ts) and the legacy unsubscribe-with-reason wire schema
// (services/unsubscribe.ts). The full responses.ts schema extends this with
// version, decision_maker_pointer, submitted_at, and tenant_signature.
export const rejectionFeedbackCommonSchema = z.object({
  primary_reason: z.enum(REJECTION_PRIMARY_REASONS),
  secondary_reasons: z.array(z.enum(REJECTION_PRIMARY_REASONS)).max(5).optional(),
  free_text: z.string().max(500).optional(),
  preferred_recontact_window: z.enum(REJECTION_RECONTACT_WINDOWS).optional(),
  consent: rejectionConsentSchema.optional(),
})

// Sentinel constants typed against the schema enums so a rename in
// REJECTION_PRIMARY_REASONS surfaces as a compile error here instead of
// a silent 0-row SQL filter at runtime.
export const FEATURE_GAP_REASON: RejectionPrimaryReason = 'feature_gap'
export const NOT_RELEVANT_REASON: RejectionPrimaryReason = 'not_relevant'

export const PMF_RELEVANT_REASONS: readonly RejectionPrimaryReason[] = [
  'feature_gap',
  'already_have_solution',
  'competitor_locked',
]

// Reapproach signal: a rejection that's conditional on time, not preference.
// The prospect should be re-eligible for outreach once the window passes.
export const REAPPROACH_REASONS: readonly RejectionPrimaryReason[] = ['wrong_timing', 'budget']

export const REAPPROACH_WINDOWS: readonly RejectionRecontactWindow[] = [
  '3_months',
  '6_months',
  '12_months',
]

// Static window lengths in months. `unspecified` is project-tunable so it
// is resolved at the call site (see reapproachWindowMonths) using the
// project_settings.unspecified_recontact_window_months value.
export const REAPPROACH_WINDOW_MONTHS: Record<RejectionRecontactWindow, number | null> = {
  never: null,
  '3_months': 3,
  '6_months': 6,
  '12_months': 12,
  unspecified: null,
}

// True when the rejection feedback indicates a hard opt-out that must flip
// do_not_contact regardless of the markDoNotContact flag the caller passed.
export function feedbackForcesDoNotContact(fb: RejectionFeedbackV1): boolean {
  return (
    fb.primary_reason === 'unsubscribe_request' ||
    fb.preferred_recontact_window === 'never' ||
    fb.consent?.gdpr_erasure_request === true ||
    fb.consent?.ccpa_opt_out === true ||
    fb.consent?.marketing_opt_out === true
  )
}

// Months to wait before re-attempting outreach. Returns null when the
// rejection is not a reapproach signal (preference rejection, no window).
// `unspecifiedMonths` is the project-configured fallback applied when the
// recipient said "yes, contact me again later" without committing to a
// concrete window — see project_settings.unspecified_recontact_window_months.
export function reapproachWindowMonths(
  fb: RejectionFeedbackV1,
  opts: { unspecifiedMonths: number },
): number | null {
  if (!REAPPROACH_REASONS.includes(fb.primary_reason)) return null
  if (!fb.preferred_recontact_window) return null
  if (fb.preferred_recontact_window === 'unspecified') return opts.unspecifiedMonths
  return REAPPROACH_WINDOW_MONTHS[fb.preferred_recontact_window]
}

// Rejection cycle ratchet: once a prospect's rejection count reaches
// maxReapproachCycles, any reapproach window is dropped. The cap is
// rejection-specific; other response types pass their window through unchanged.
export function resolveEffectiveReapproachWindow(args: {
  responseType: ResponseType
  rejectionCycle: number
  maxReapproachCycles: number
  requestedWindowMonths: number | null
}): { cycleCapReached: boolean; effectiveWindowMonths: number | null } {
  const cycleCapReached =
    args.responseType === 'rejection' && args.rejectionCycle >= args.maxReapproachCycles
  return {
    cycleCapReached,
    effectiveWindowMonths: cycleCapReached ? null : args.requestedWindowMonths,
  }
}
