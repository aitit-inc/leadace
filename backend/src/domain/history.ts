// The project's sales record, the same on every surface: what was decided, what
// was done each day, what came back. A decision's lesson is its reason and what
// followed, so a lesson is not a kind of row.
import type { AceEvidence, ChangeSignal, DocumentTarget, LoggedChange, LoggedRuleChange, OptionOp, OptionTarget, RuleEvidence } from './loop/change'
import { percentOf } from './dashboard'
import { reachLine } from './loop/change'
import type { Evidence } from './loop/evidence'
import type { FramePeriod } from './loop/frame'
import type { ProposalStatus, ProposedChange } from './loop/proposal'
import { sendOutcome, type Reaction } from './loop/reaction'

export const HISTORY_WINDOW_DAYS = 30

// From the start of a UTC day: a row's numbers are the whole day's or none.
export const historySince = (days: number, now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))

export type HistoryProposal = { title: string; status: ProposalStatus; change: ProposedChange; createdAt: Date }

const utcDay = (d: Date): string => d.toISOString().slice(0, 10)
const newestFirst = (a: { date: string }, b: { date: string }): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)

// One UTC day's work and what arrived that day, whichever day it was sent.
export type ActivityDay = {
  date: string
  researched: number
  notFit: number
  noContact: number
  contacted: number
  followUps: number
  positive: number
  interested: number
  declined: number
  bounced: number
}

const emptyDay = (date: string): ActivityDay => ({ date, researched: 0, notFit: 0, noContact: 0, contacted: 0, followUps: 0, positive: 0, interested: 0, declined: 0, bounced: 0 })

// One row per reaction; a send answered twice in a day counts once that day, by its strongest.
export function buildActivityDays(input: {
  research: ReadonlyArray<{ day: string; researched: number; notFit: number; noContact: number }>
  sends: ReadonlyArray<{ day: string; contacted: number; followUps: number }>
  reactions: ReadonlyArray<{ day: string; outreachLogId: number; reaction: Reaction }>
}): ActivityDay[] {
  const days = new Map<string, ActivityDay>()
  const dayRow = (date: string): ActivityDay => {
    const held = days.get(date) ?? emptyDay(date)
    days.set(date, held)
    return held
  }
  for (const { day, researched, notFit, noContact } of input.research) Object.assign(dayRow(day), { researched, notFit, noContact })
  for (const { day, contacted, followUps } of input.sends) Object.assign(dayRow(day), { contacted, followUps })
  const bySendDay = new Map<string, { day: string; reactions: Reaction[] }>()
  for (const { day, outreachLogId, reaction } of input.reactions) {
    const key = `${day}:${outreachLogId}`
    const held = bySendDay.get(key) ?? { day, reactions: [] }
    held.reactions.push(reaction)
    bySendDay.set(key, held)
  }
  for (const { day, reactions } of bySendDay.values()) {
    const row = dayRow(day)
    const outcome = sendOutcome(reactions)
    if (outcome.kind === 'positive') row.positive++
    if (outcome.kind === 'positive' || outcome.kind === 'interest') row.interested++
    if (outcome.kind === 'declined') row.declined++
    if (outcome.kind === 'bounced') row.bounced++
  }
  return [...days.values()]
}

export type HistoryOutcomes = {
  variants: ReadonlyMap<string, Evidence>
  strategies: ReadonlyMap<string, Evidence>
  found: ReadonlyMap<string, { registered: number; unqualified: number; noContact: number }>
  // Oldest first; the first is the time before any frame.
  frames: readonly FramePeriod[]
  // The sends of [from, to), up to now when to is null.
  sendsBetween: (from: Date, to: Date | null) => Evidence
}

export type HistoryRow = {
  date: string
  // null on a day's work: nobody decided it.
  who: 'You' | 'Ace' | 'Rule' | null
  text: string
  // What the decision rested on or changed, and why.
  notes: string[]
  result: string | null
  // Ace or the rule acted on what it measured.
  learned: boolean
}

const SIGNAL_WORDS: Record<ChangeSignal, string> = {
  replies: 'reply rates',
  declines: 'the noes',
  bounces: 'bounces',
  discovery: 'what discovery found',
  person: 'your corrections',
}

const OPTION_VERBS: Record<OptionTarget, Record<OptionOp, string>> = {
  variant: { add: 'Started testing the angle', update: 'Rewrote the angle', archive: 'Retired the angle', restore: 'Brought back the angle' },
  strategy: { add: 'Started searching via', update: 'Changed the search', archive: 'Stopped searching via', restore: 'Resumed searching via' },
}
const DOCUMENT_NAMES: Record<DocumentTarget, string> = { sales_strategy: 'the sales strategy', business: 'the business profile' }
const PROPOSAL_OUTCOME = { applied: 'Applied', stopped: 'You stopped it', outdated: 'Dropped: a change came first' } as const

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const joined = (parts: readonly (string | null | false | undefined)[]): string | null => parts.filter(Boolean).join(' · ') || null

// Counts, not rates: on a few reactions a rate reads as a trend it is not.
const sendsLine = (e: Evidence): string | null =>
  e.sends === 0 ? null : joined([plural(e.sends, 'send'), e.positive > 0 && `${e.positive} positive`, e.interested > 0 && `${e.interested} with interest`, e.declined > 0 && `${e.declined} said no`, e.bounced > 0 && plural(e.bounced, 'bounce')])

const present = (parts: readonly (string | null)[]): string[] => parts.filter((part) => part !== null)

const onSignals = (evidence: AceEvidence | null): string | null =>
  evidence ? `On ${evidence.signals.map((s) => SIGNAL_WORDS[s]).join(', ')}` : null

function ruleDetail(evidence: RuleEvidence | null): string | null {
  if (!evidence) return null
  const p = 'pBest' in evidence ? evidence.pBest : evidence.pBeatsLeader
  return `Win chance ${Math.round(p * 100)}% · ${plural(Math.round(evidence.n), 'send')}`
}

const framePeriod = ({ trials, positive }: FramePeriod): string =>
  `${positive} positive of ${Math.round(trials)} counted (${percentOf(positive, trials)}%)`

function optionResult(target: OptionTarget, optionId: string, outcomes: HistoryOutcomes): string | null {
  const sends = (target === 'variant' ? outcomes.variants : outcomes.strategies).get(optionId)
  const found = target === 'strategy' ? outcomes.found.get(optionId) : undefined
  return joined([
    found && `${found.registered} found`,
    found && found.unqualified > 0 && `${found.unqualified} didn't fit`,
    found && found.noContact > 0 && `${found.noContact} with no way to reach them`,
    sends && sendsLine(sends),
  ])
}

function ruleRow(c: LoggedRuleChange, name: string, result: string | null): HistoryRow {
  const search = c.target === 'strategy'
  const text = c.op === 'restore'
    ? `${search ? 'Resumed searching via' : 'Brought back'} ${name}: its results caught up`
    : c.reason === 'rotated'
      ? `Swapped out ${name}: results stayed flat`
      : search ? `Stopped searching via ${name}: another search did better` : `Retired ${name}: a stronger angle won`
  return { date: c.day, who: 'Rule', text, notes: present([ruleDetail(c.evidence)]), result, learned: true }
}

function changeRow(c: LoggedChange, labels: ReadonlyMap<string, string | null>, result: string | null): HistoryRow {
  const name = (target: OptionTarget, optionId: string): string =>
    `“${(target === 'variant' ? labels.get(optionId) : null) ?? optionId}”`
  if (c.actor === 'rule') return ruleRow(c, name(c.target, c.optionId), result)
  const row = {
    date: c.day,
    who: c.actor === 'user' ? 'You' as const : 'Ace' as const,
    notes: present([onSignals(c.evidence), c.reason]),
    result,
    learned: c.evidence !== null,
  }
  if ('optionId' in c) return { ...row, text: `${OPTION_VERBS[c.target][c.op]} ${name(c.target, c.optionId)}` }
  if (c.target === 'settings') return { ...row, text: 'Changed how Ace reaches out', notes: [reachLine(c.diff), ...row.notes] }
  if (c.target === 'frame') return { ...row, text: 'Started a new frame' }
  return { ...row, text: `Edited ${DOCUMENT_NAMES[c.target]}` }
}

function proposalRow(p: HistoryProposal): HistoryRow {
  return {
    date: utcDay(p.createdAt),
    who: 'Ace',
    text: `Proposed: ${p.title}`,
    notes: [],
    result: p.status !== 'pending'
      ? PROPOSAL_OUTCOME[p.status]
      : p.change.kind === 'add-means' ? 'Waiting for you to set it up' : `Applies ${p.change.applyOn} unless you stop it`,
    learned: false,
  }
}

function activityRow(day: ActivityDay): HistoryRow {
  return {
    date: day.date,
    who: null,
    text: joined([
      day.researched > 0 && `Looked at ${plural(day.researched, 'company', 'companies')}`,
      day.notFit > 0 && `${day.notFit} didn't fit`,
      day.noContact > 0 && `${day.noContact} with no way to reach them`,
      day.contacted > 0 && `Contacted ${day.contacted}`,
      day.followUps > 0 && plural(day.followUps, 'follow-up'),
    ]) ?? 'Replies came in',
    notes: [],
    result: joined([
      day.positive > 0 && `${day.positive} positive`,
      day.interested > day.positive && `${day.interested - day.positive} with interest`,
      day.declined > 0 && `${day.declined} said no`,
      day.bounced > 0 && plural(day.bounced, 'bounce'),
    ]),
    learned: false,
  }
}

// `changes` newest first. An option's sends count over its whole life on the row
// that added it, a strategy edit's only until the next edit.
function resultsOf(changes: readonly LoggedChange[], outcomes: HistoryOutcomes): Map<LoggedChange, string | null> {
  const results = new Map<LoggedChange, string | null>()
  const frames = changes.filter((c) => c.target === 'frame').reverse()
  const first = outcomes.frames.length - frames.length
  frames.forEach((c, i) => {
    const period = outcomes.frames[first + i]
    const before = outcomes.frames[first + i - 1]
    if (period) results.set(c, joined([framePeriod(period), before && `The frame before: ${framePeriod(before)}`]))
  })
  let nextEdit: Date | null = null
  for (const c of changes) {
    if ('optionId' in c && c.op === 'add') results.set(c, optionResult(c.target, c.optionId, outcomes))
    if (c.target === 'sales_strategy') {
      const sends = sendsLine(outcomes.sendsBetween(c.at, nextEdit))
      results.set(c, sends && `Since then: ${sends}`)
      nextEdit = c.at
    }
  }
  return results
}

const byTitle = (a: HistoryProposal, b: HistoryProposal): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)

// Newest first; within a day the log's order, then the proposals, then the day's work.
export function buildHistory(
  changes: readonly LoggedChange[],
  variants: ReadonlyArray<{ variantId: string; label: string | null }>,
  proposals: readonly HistoryProposal[],
  days: readonly ActivityDay[],
  outcomes: HistoryOutcomes,
): HistoryRow[] {
  const labels = new Map(variants.map((v) => [v.variantId, v.label]))
  const results = resultsOf(changes, outcomes)
  return [
    ...changes.map((c) => changeRow(c, labels, results.get(c) ?? null)),
    ...[...proposals].sort(byTitle).map(proposalRow),
    ...days.map(activityRow),
  ].sort(newestFirst)
}

export function historyLine(row: HistoryRow): string {
  const head = `${row.date} ${row.who ? `${row.who}: ` : ''}${row.text}`
  return [head, ...row.notes, row.result].filter(Boolean).join(' — ')
}
