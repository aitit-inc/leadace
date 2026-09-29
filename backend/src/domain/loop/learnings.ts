// Stage tags /evaluate writes into the Learnings Log, one per downstream decision a
// skill acts on. '[retired]' is a tombstone, not a stage — readers (and parseLearnings) skip it.
export const LEARNING_STAGES = ['targeting', 'body', 'timing', 'channel', 'discovery'] as const
export type LearningStage = (typeof LEARNING_STAGES)[number]

export type LearningEntry = { stage: LearningStage; date: string; claim: string; evidence: string | null }

// Withdrawn because the measurement itself was unsound, not because the
// numbers moved: no observation can retract such a metric, so the call is
// made here when the metric leaves the evaluate payload.
const WITHDRAWN_METRICS = [
  // #494: had_fresh_signal was set by the ordering that already preferred
  // signal-carrying prospects, so the rate compared a selected arm to its leftovers.
  'freshSignalResponseRate',
] as const

const ENTRY_TAG = /^(\s*-\s*\[)([a-z]+)(\])/
// One regex per metric, so an empty list matches nothing rather than matching
// every "metric=". The optional prefix covers the nested form entries use for
// lever axes (metric=targetingLifts.discoveryStrategy).
const WITHDRAWN_CITATIONS = WITHDRAWN_METRICS.map(
  (m) => new RegExp(`metric=(?:[A-Za-z0-9_]+\\.)?${m}(?![A-Za-z0-9_])`),
)

export function retireWithdrawnMetricEntries(log: string): string {
  return log
    .split('\n')
    .map((line) => {
      const tag = ENTRY_TAG.exec(line)
      if (!tag || tag[2] === 'retired' || !WITHDRAWN_CITATIONS.some((re) => re.test(line))) return line
      return line.replace(ENTRY_TAG, '$1retired$3')
    })
    .join('\n')
}

const LEARNING_STAGE_SET = new Set<string>(LEARNING_STAGES)
// Each entry: "[stage] [YYYY-MM-DD] claim — evidence: metric=…, n=…". Tolerant of a
// leading markdown bullet since the doc is LLM-authored; the evidence tail is trimmed
// for the glance card. Unrecognized lines (headers, '[retired]' tombstones) are dropped.
const LEARNING_LINE = /^\[([a-z_]+)\]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/i

export function parseLearnings(content: string | null): LearningEntry[] {
  if (!content) return []
  const out: LearningEntry[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '')
    const m = LEARNING_LINE.exec(line)
    if (!m) continue
    const stage = m[1]!.toLowerCase()
    if (!LEARNING_STAGE_SET.has(stage)) continue
    const rest = m[3]!.trim()
    const [claimPart, ...evidenceParts] = rest.split(/\s*[—–-]+\s*evidence:\s*/i)
    const claim = claimPart!.trim()
    const evidence = evidenceParts.join(' ').trim() || null
    out.push({ stage: stage as LearningStage, date: m[2]!, claim: claim || rest, evidence })
  }
  // Newest first: the doc's line order is LLM-authored and undefined, but the glance card
  // truncates to the top few — surface the most recent learnings deterministically.
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// An entry the evaluate stage has tombstoned (#744): '- [retired] [date] claim — evidence: …'.
const RETIRED_LINE = /^\[retired\]\s*(?:\[\d{4}-\d{2}-\d{2}\]\s*)?(.+)$/i

function retiredClaim(line: string): string | null {
  const m = RETIRED_LINE.exec(line.trim().replace(/^[-*]\s+/, ''))
  if (!m) return null
  const [claim] = m[1]!.split(/\s*[—–-]+\s*evidence:\s*/i)
  return claim!.trim()
}

function retiredClaims(log: string | null): Set<string> {
  const out = new Set<string>()
  if (!log) return out
  for (const raw of log.split('\n')) {
    const claim = retiredClaim(raw)
    if (claim !== null) out.add(claim)
  }
  return out
}

// A tombstone keeps the entry's text, so the claims that turned up between the
// two versions of the log are what was un-learned since.
export function newlyRetiredClaims(before: string | null, after: string | null): string[] {
  const was = retiredClaims(before)
  return Array.from(retiredClaims(after)).filter((c) => !was.has(c))
}

const ENTRY_DATE = /\d{4}-\d{2}-\d{2}/

// Retiring keeps the claim's own date; a tombstone dated the day it was
// retired is what lets keepNewestRetired keep the recent ones.
export function stampNewRetirements(before: string | null, after: string, today: string): string {
  const was = retiredClaims(before)
  return after
    .split('\n')
    .map((line) => {
      const claim = retiredClaim(line)
      if (claim === null || was.has(claim)) return line
      return ENTRY_DATE.test(line) ? line.replace(ENTRY_DATE, today) : line.replace(/\[retired\]/i, `[retired] [${today}]`)
    })
    .join('\n')
}

// Tombstones exist so a claim does not come straight back; the newest ones are
// enough for that, and keeping every one would grow the log without bound.
export function keepNewestRetired(log: string, keep: number): string {
  const lines = log.split('\n')
  const retired = lines
    .map((line, i) => ({ i, date: ENTRY_DATE.exec(line)?.[0] ?? '', isRetired: retiredClaim(line) !== null }))
    .filter((l) => l.isRetired)
  if (retired.length <= keep) return log
  const dropped = new Set(
    retired
      .sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i)
      .slice(keep)
      .map((l) => l.i),
  )
  return lines.filter((_, i) => !dropped.has(i)).join('\n')
}
