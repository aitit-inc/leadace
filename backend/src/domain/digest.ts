// Assembled from what the dashboard already computed. No LLM call: the email
// and the dashboard must never disagree about a number.
import type { DashboardSummary, JournalEvent, RateChange, SegmentAxis } from './dashboard'

// A digest covers whole UTC days, [sinceDay, today): the day is all the
// resolution a journal event carries, so reporting a day still in progress
// would either lose what the rest of it records or repeat what was already
// reported. Today's changes go out in the next digest.
export type DigestInput = {
  projectName: string
  // 'YYYY-MM-DD' UTC days: the day the last digest covered up to, and today.
  sinceDay: string
  today: string
  summary: DashboardSummary
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

export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS)
}

function quote(claim: string): string {
  return `"${claim.replace(/\s+/g, ' ').trim()}"`
}

const OPTION_HEAD = {
  variant: { add: 'New angle', update: 'Angle edited', archive: 'Angle retired', restore: 'Angle back' },
  strategy: { add: 'New search strategy', update: 'Search strategy edited', archive: 'Search strategy retired', restore: 'Search strategy back' },
} as const
const DOCUMENT_HEAD = { sales_strategy: 'Sales strategy adjusted', business: 'Business profile updated' } as const

function journalLine(e: JournalEvent): string {
  const by = (actor: 'ace' | 'user', reason: string | null): string => `${actor === 'user' ? ' (by you)' : ''}${reason ? ` — ${reason}` : ''}`
  switch (e.kind) {
    case 'strategy_escalated':
      return `Discovery strategy raised: ${e.title}`
    case 'document':
      return `${DOCUMENT_HEAD[e.target]}${by(e.actor, e.reason)}`
    case 'option':
      return `${OPTION_HEAD[e.target][e.op]}: ${e.label ?? e.optionId}${by(e.actor, e.reason)}`
    case 'rule_archive':
      return `${OPTION_HEAD[e.target].archive}: ${e.label ?? e.optionId} (${e.reason === 'rotated' ? 'no traction' : `another ${e.target === 'variant' ? 'angle' : 'strategy'} won`})`
    case 'rule_restore':
      return `${OPTION_HEAD[e.target].restore}: ${e.label ?? e.optionId} (its results caught up)`
  }
}

function digestChanges(input: DigestInput): string[] {
  const { sinceDay, today, summary } = input
  return summary.journal.filter((e) => e.date >= sinceDay && e.date < today).map(journalLine)
}

function resultsLine(summary: DashboardSummary): string {
  const { approached, engaged, won } = summary.kpis
  const rate = ({ current, previous }: RateChange) => `${current}%${approached.previous > 0 ? ` (was ${previous}%)` : ''}`
  const { positive, interested } = summary.reactionRates
  return `Contacted ${approached.current} prospect${approached.current === 1 ? '' : 's'} · positive ${rate(positive)} · with interest ${rate(interested)} · engaged ${engaged.current} · won ${won.current}`
}

function marketSection(summary: DashboardSummary): string[] {
  const segments = summary.segments.map((s) => {
    const rows = s.rows
      .map((r) => `${s.axis === 'industry' ? humanize(r.value) : r.value} ${r.positiveRate}% / ${r.interestedRate}% of ${r.sent}`)
      .join(' · ')
    return `${SEGMENT_AXIS_LABELS[s.axis]}: ${rows}`
  })
  const lines = segments.length > 0 ? ['Positive / with interest, of the prospects contacted:', ...segments] : []
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
