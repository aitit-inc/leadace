// Pure helpers for 'skipped' outreach_logs rows. A skip records that an
// outbound run deliberately declined to contact a prospect (no send attempted)
// — e.g. bad timing or no fresh re-approach material, both LLM judgments the
// server cannot make on its own. The structured reason lives in
// outreach_logs.skip_reason; this module builds the human-readable audit body
// that surfaces in the recent-outreach feed (outreach_logs.body is NOT NULL).
import type { SkipReason } from '../db/schema'

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  bad_timing: 'bad timing',
  no_fresh_material: 'no fresh material for re-approach',
  other: 'other',
}

// Body stored on the skip row (NOT NULL column) and shown verbatim in the
// /outreach feed. The optional free-text note carries extra context and is
// appended after an em dash when present.
export function buildSkipAuditBody(reason: SkipReason, note?: string | null): string {
  const base = `Skipped: ${SKIP_REASON_LABELS[reason]}`
  const trimmed = note?.trim()
  return trimmed ? `${base} — ${trimmed}` : base
}
