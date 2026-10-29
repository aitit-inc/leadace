// Assembled from what the dashboard already computed. No LLM call: the email
// and the dashboard must never disagree about a number.
import type { AttentionItem, QuotaAllowance, QuotaConstraint } from './attention'
import { percentOf, type DashboardSummary, type JournalEvent, type LoopReport, type RateChange, type SegmentAxis } from './dashboard'
import { CHANGE_SIGNALS, reachLine, type AceEvidence, type ChangeSignal } from './loop/change'
import type { FramePeriod } from './loop/frame'
import type { ProposedChange } from './loop/proposal'

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

// Mirrors the dashboard's humanize().
function humanize(s: string): string {
  const t = s.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
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

const SIGNAL_WORDS: Record<ChangeSignal, string> = {
  replies: 'reply rates',
  declines: 'the noes',
  bounces: 'bounces',
  discovery: 'what discovery found',
  person: 'your corrections',
}

const PROPOSAL_OUTCOME = { applied: 'applied', stopped: 'you stopped it', outdated: 'dropped: a change came first' } as const
const pendingNote = (change: ProposedChange): string =>
  change.kind === 'add-means' ? 'waiting for you to set it up' : `applies ${change.applyOn} unless you stop it`

function journalLine(e: JournalEvent): string {
  const by = (actor: 'ace' | 'user', reason: string | null, evidence: AceEvidence | null): string => {
    const who = actor === 'user' ? ' (by you)' : evidence ? ` (on ${evidence.signals.map((sig) => SIGNAL_WORDS[sig]).join(', ')})` : ''
    return `${who}${reason ? ` — ${reason}` : ''}`
  }
  switch (e.kind) {
    case 'proposed':
      return `Proposed to you: ${e.title} (${e.status === 'pending' ? pendingNote(e.change) : PROPOSAL_OUTCOME[e.status]})`
    case 'settings':
      return `${reachLine(e.diff)}${by(e.actor, e.reason, e.evidence)}`
    case 'frame':
      return `New frame: measuring from here${by(e.actor, e.reason, e.evidence)}`
    case 'document':
      return `${DOCUMENT_HEAD[e.target]}${by(e.actor, e.reason, e.evidence)}`
    case 'option':
      return `${OPTION_HEAD[e.target][e.op]}: ${e.label ?? e.optionId}${by(e.actor, e.reason, e.evidence)}`
    case 'rule_archive':
      return `${OPTION_HEAD[e.target].archive}: ${e.label ?? e.optionId} (${e.reason === 'rotated' ? 'no traction' : `another ${e.target === 'variant' ? 'angle' : 'strategy'} won`})`
    case 'rule_restore':
      return `${OPTION_HEAD[e.target].restore}: ${e.label ?? e.optionId} (its results caught up)`
  }
}

function digestEvents(input: DigestInput): JournalEvent[] {
  const { sinceDay, today, summary } = input
  return summary.journal.filter((e) => e.date >= sinceDay && e.date < today)
}

// Counts as the loop section does (changeSignals): setup, the person's own
// edits and proposals are reported, not counted.
function learnedFrom(e: JournalEvent): boolean {
  return e.kind === 'rule_archive' || e.kind === 'rule_restore' || (e.kind !== 'proposed' && e.evidence !== null)
}

const QUOTA_LINE: Record<QuotaAllowance, Record<QuotaConstraint, string>> = {
  contacted: {
    lifetime: 'Every prospect in your plan has been contacted. Follow-ups still go out; open the plans page to reach new ones.',
    monthly: 'This period\'s prospect allowance is used. Follow-ups still go out; new prospects resume next period, or buy credits or upgrade on the plans page to continue now.',
  },
  found: {
    lifetime: 'No one is left to contact and your plan\'s discovery is used up. Follow-ups still go out; bring your own list, or open the plans page to find more.',
    monthly: 'No one is left to contact and this period\'s discovery is used up. Follow-ups still go out; bring your own list, or buy credits or upgrade on the plans page to find more now.',
  },
}

// Judged once in domain/attention; this only words it.
function attentionLine(item: AttentionItem): string {
  switch (item.kind) {
    case 'hot_leads':
      return `${item.count} meeting request${item.count === 1 ? '' : 's'} waiting — book the call.`
    case 'no_project':
      return 'Finish setting up: paste your website URL in the chat.'
    case 'compliance_incomplete':
      return `Sending is blocked until you add: ${item.missing.map(humanize).join(', ')}.`
    case 'gmail_disconnected':
      return 'Gmail is not connected — connect it to send the emails you approve.'
    case 'gmail_auth_revoked':
      return `Google rejected the saved access for ${item.fromEmail}: sending and reply collection are stopped until you reconnect.`
    case 'mailbox_send_refused':
      return `The mail provider refused to send from ${item.fromEmail}: unblock it with the provider.`
    case 'mailbox_inbox_test_spam':
      return `Email from ${item.fromEmail} is landing in spam (${item.spam} of ${item.delivered} test copies), so sending from it is held.`
    case 'no_outbound_channels':
      return 'Outbound is paused: no channel is enabled in project settings.'
    case 'quota_exhausted':
      return QUOTA_LINE[item.allowance][item.constraint]
    case 'subscription_unpaid':
      return 'Your subscription isn\'t paid: the plan is on Free until Stripe collects the payment. Check the card under Manage subscription on the plans page.'
    case 'credit_top_up_failed':
      return 'Credit auto top-up was declined: update the card in the Stripe portal, then switch it back on.'
    case 'reply_collection_scope_missing':
      return `Replies to ${item.fromEmail} are not being read: permission to read them was never granted.`
    case 'reply_collection_failing':
      return `Checking ${item.fromEmail} for replies has been failing since ${item.since.slice(0, 10)}.`
    case 'outreach_futility':
      return `Outreach in ${item.projectName} is drawing no interest (${item.engaged} of ${Math.round(item.sends)} delivered emails engaged): check deliverability and targeting.`
    case 'outreach_drafts':
      return `${item.count} draft${item.count === 1 ? '' : 's'} ready to review.`
  }
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

const frameRate = ({ trials, positive }: FramePeriod): string =>
  `${positive} positive of ${Math.round(trials)} counted (${percentOf(positive, trials)}%)`

function loopSection({ changes, bySignal, frame, previousFrame }: LoopReport): string[] {
  const signals = CHANGE_SIGNALS.map((sig) => `${SIGNAL_WORDS[sig]} ${bySignal[sig]}`).join(' · ')
  return [
    `${changes} change${changes === 1 ? '' : 's'} by Ace, resting on: ${signals}`,
    `This frame (since ${frame.start?.day ?? 'the first send'}): ${frameRate(frame)}${previousFrame ? ` · the frame before: ${frameRate(previousFrame)}` : ''}`,
  ]
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ['', title, ...lines] : []
}

// null when there is nothing worth an email.
export function buildDigest(input: DigestInput): Digest | null {
  const events = digestEvents(input)
  const changes = events.map(journalLine)
  const learned = events.filter(learnedFrom).length
  if (changes.length === 0 && daysBetween(input.sinceDay, input.today) < HEARTBEAT_DAYS) return null
  const market = marketSection(input.summary)
  // A heartbeat with no sends, no findings and nothing that needs the person would report only zeros.
  if (changes.length === 0 && input.summary.kpis.approached.current === 0 && market.length === 0 && input.summary.attention.length === 0) return null

  const body = [
    `${input.projectName} — last 30 days`,
    resultsLine(input.summary),
    ...section('Needs you', input.summary.attention.map(attentionLine)),
    ...section('What the market is telling you', market),
    ...section('How Ace learned (last 30 days)', loopSection(input.summary.loop)),
    ...section(
      `What changed since ${input.sinceDay}`,
      changes.length > 0 ? changes : ['Nothing — the system kept running on what it already learned.'],
    ),
  ].join('\n')

  return {
    subject:
      learned > 0
        ? `${input.projectName}: ${learned} change${learned === 1 ? '' : 's'} from what we learned`
        : `${input.projectName}: no change from what we learned since ${input.sinceDay}`,
    body,
  }
}
