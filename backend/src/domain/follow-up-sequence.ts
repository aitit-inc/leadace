import { z } from 'zod'

// Day-scale follow-up sequence config (P1). gapDays are RELATIVE waits (days)
// before each next touch — relative, not absolute-from-first-send, so an
// irregular /daily-cycle cadence preserves spacing. Default [3,7,7] = touches at
// day 0/3/10/17; maxTouches = gapDays.length + 1.
const gapDaysSchema = z.array(z.coerce.number().int().min(1).max(90)).min(1).max(5)

export const followUpSequenceSchema = z.object({
  // Defaults false so existing rows ({}) read as off; new projects seed
  // { enabled: true } at creation (opt-out for new data).
  enabled: z.boolean().default(false),
  gapDays: gapDaysSchema.default([3, 7, 7]),
})
export type FollowUpSequence = z.infer<typeof followUpSequenceSchema>
export const defaultFollowUpSequence: FollowUpSequence = followUpSequenceSchema.parse({})

// Overrides-only storage shape (the jsonb $type): unset fields fill at read, so
// default changes need no backfill.
export const followUpSequencePatchSchema = z.object({
  enabled: z.boolean().optional(),
  gapDays: gapDaysSchema.optional(),
})
export type FollowUpSequencePatch = z.infer<typeof followUpSequencePatchSchema>
