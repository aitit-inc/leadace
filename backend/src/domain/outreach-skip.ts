// A skip: an outbound run deliberately declined to contact a prospect (no
// send attempted) — an LLM judgment the server cannot make on its own. The
// audit body fills outreach_logs.body (NOT NULL) for the /outreach feed.
import type { SkipReason } from '../db/schema'

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  bad_timing: 'bad timing',
  no_fresh_material: 'no fresh material for re-approach',
  other: 'other',
}

export function buildSkipAuditBody(reason: SkipReason, note?: string | null): string {
  const base = `Skipped: ${SKIP_REASON_LABELS[reason]}`
  const trimmed = note?.trim()
  return trimmed ? `${base} — ${trimmed}` : base
}
