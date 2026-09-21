// Assembled from what the dashboard already computed. No LLM call: the email
// and the dashboard must never disagree about a number.
import type { DashboardSummary, JournalEvent, LearningEntry, SegmentAxis } from './dashboard'

// A digest covers whole UTC days, [sinceDay, today): the day is all the
// resolution a journal event or a learnings entry carries, so reporting a day
// still in progress would either lose what the rest of it records or repeat
// what was already reported. Today's changes go out in the next digest.
export type DigestInput = {
  projectName: string
  // 'YYYY-MM-DD' UTC days: the day the last digest covered up to, and today.
  sinceDay: string
  today: string
  summary: DashboardSummary
  // Retired within the window, not every retired claim.
  retiredClaims: string[]
}

export type Digest = { subject: string; body: string }

// With nothing to report the digest still goes out this often, so the user
// hears that the system is running.
const HEARTBEAT_DAYS = 7

const SEGMENT_AXIS_LABELS: Record<SegmentAxis, string> = {
  industry: 'Industry',
  employeeBand: 'Company size',
  country: 'Country',
  discoveryStrategy: 'Where they were found',
}

// Mirrors the dashboard's humanize(): snake_case labels read as sentences.
function humanize(s: string): string {
  const t = s.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

const DAY_MS = 24 * 60 * 60 * 1000

export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10)
}

// The window's own boundaries as instants, for the document versions that carry
// a timestamp rather than a day.
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS)
}

function quote(claim: string): string {
  return `"${claim.replace(/\s+/g, ' ').trim()}"`
}

function learningLine(e: LearningEntry): string {
  return `Learned [${e.stage}]: ${e.claim}`
}

function journalLine(e: JournalEvent): string {
  switch (e.kind) {
    case 'variant_added':
      return `New angle: ${e.label ?? e.variantId}`
    case 'variant_archived':
      return `Angle retired: ${e.label ?? e.variantId} (${e.reason === 'stagnation' ? 'no traction' : 'another angle won'})`
    case 'strategy_escalated':
      return `Discovery strategy raised: ${e.title}`
  }
}

// The retired learnings lead: what was un-learned shows on no other screen.
function digestChanges(input: DigestInput): string[] {
  const { sinceDay, today, summary, retiredClaims } = input
  const inWindow = (date: string): boolean => date >= sinceDay && date < today
  return [
    ...retiredClaims.map((c) => `Un-learned: ${quote(c)} — the measurement it rested on was withdrawn`),
    ...summary.learning.log.filter((e) => inWindow(e.date)).map(learningLine),
    ...summary.journal.filter((e) => inWindow(e.date)).map(journalLine),
  ]
}

function resultsLine(summary: DashboardSummary): string {
  const { approached, engaged, won } = summary.kpis
  const { current, previous } = summary.replyRateTrend
  const replyRate = `${current}%${approached.previous > 0 ? ` (was ${previous}%)` : ''}`
  return `Contacted ${approached.current} prospect${approached.current === 1 ? '' : 's'} · reply rate ${replyRate} · engaged ${engaged.current} · won ${won.current}`
}

function marketSection(summary: DashboardSummary): string[] {
  const lines = summary.segments.map((s) => {
    const rows = s.rows
      .map((r) => `${s.axis === 'industry' ? humanize(r.value) : r.value} ${r.replyRate}% (${r.replied}/${r.sent})`)
      .join(' · ')
    return `${SEGMENT_AXIS_LABELS[s.axis]}: ${rows}`
  })
  const { rejections } = summary
  if (rejections.topReasons.length > 0) {
    const reasons = rejections.topReasons
      .slice(0, 3)
      .map((r) => `${humanize(r.reason)} ${r.percentage}%`)
      .join(' · ')
    lines.push(`Why ${rejections.total} said no: ${reasons}`)
  }
  const gap = rejections.productSignal
  if (gap) {
    lines.push(`Missing feature named by ${gap.count}:`)
    lines.push(...gap.quotes.slice(0, 2).map((q) => `  ${quote(q.freeText)} — ${q.prospectName}, ${q.organizationName}`))
  }
  return lines
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ['', title, ...lines] : []
}

// null when there is nothing worth an email.
export function buildDigest(input: DigestInput): Digest | null {
  const changes = digestChanges(input)
  if (changes.length === 0 && daysBetween(input.sinceDay, input.today) < HEARTBEAT_DAYS) return null
  const market = marketSection(input.summary)
  // A heartbeat with no sends and no findings would report only zeros.
  if (changes.length === 0 && input.summary.kpis.approached.current === 0 && market.length === 0) return null

  const body = [
    `${input.projectName} — last 30 days`,
    resultsLine(input.summary),
    ...section('What the market is telling you', market),
    ...section(
      `What changed since ${input.sinceDay}`,
      changes.length > 0 ? changes : ['Nothing — the system kept running on what it already learned.'],
    ),
  ].join('\n')

  return {
    subject:
      changes.length > 0
        ? `${input.projectName}: ${changes.length} change${changes.length === 1 ? '' : 's'} from what we learned`
        : `${input.projectName}: no change since ${input.sinceDay}`,
    body,
  }
}

// An entry the evaluate stage has tombstoned (#744): '- [retired] [date] claim — evidence: …'.
const RETIRED_LINE = /^\[retired\]\s*(?:\[\d{4}-\d{2}-\d{2}\]\s*)?(.+)$/i

function retiredClaims(log: string | null): Set<string> {
  const out = new Set<string>()
  if (!log) return out
  for (const raw of log.split('\n')) {
    const m = RETIRED_LINE.exec(raw.trim().replace(/^[-*]\s+/, ''))
    if (!m) continue
    const [claim] = m[1]!.split(/\s*[—–-]+\s*evidence:\s*/i)
    out.add(claim!.trim())
  }
  return out
}

// A tombstone keeps the entry's text, so the claims that turned up between the
// two versions of the log are what was un-learned since.
export function newlyRetiredClaims(before: string | null, after: string | null): string[] {
  const was = retiredClaims(before)
  return Array.from(retiredClaims(after)).filter((c) => !was.has(c))
}
