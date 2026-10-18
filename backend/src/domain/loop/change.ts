import { z } from 'zod'
import type { OutboundChannel } from '../outbound-channel'
import type { Locale } from '../locale'

// One policy_changes row per change to an option, a policy document or the
// project's reach (channels, countries, language), and a 'frame' row where a
// new frame starts: the loop measures from the latest one. The tick's daily
// reweighting is not in it; that is lever_decisions.
export const POLICY_TARGETS = ['variant', 'strategy', 'business', 'sales_strategy', 'settings', 'frame'] as const
type PolicyTarget = (typeof POLICY_TARGETS)[number]
export type OptionTarget = Extract<PolicyTarget, 'variant' | 'strategy'>
export type DocumentTarget = Extract<PolicyTarget, 'business' | 'sales_strategy'>

export const POLICY_OPS = ['add', 'update', 'archive', 'restore'] as const
export type OptionOp = (typeof POLICY_OPS)[number]

export const POLICY_ACTORS = ['rule', 'ace', 'user'] as const

export const RULE_ARCHIVE_REASONS = ['lost', 'rotated'] as const
export type RuleArchiveReason = (typeof RULE_ARCHIVE_REASONS)[number]
// The probability the rule held against its threshold: P(it beats the leader)
// for a lost or restored option; P(best) among the active set for a rotation
// and for every archive from before the leader test. Absent on archives the
// tick made before it recorded any.
export type RuleEvidence = { n: number } & ({ pBest: number } | { pBeatsLeader: number })

export const CHANGE_SIGNALS = ['replies', 'declines', 'bounces', 'discovery', 'person'] as const
export type ChangeSignal = (typeof CHANGE_SIGNALS)[number]

export const changeSignalsSchema = z.array(z.enum(CHANGE_SIGNALS)).min(1)

// What one of Ace's loop changes rests on: the kinds of evidence it named.
export type AceEvidence = { signals: ChangeSignal[] }
export type ChangeEvidence = RuleEvidence | AceEvidence

// `evidence` is null on a change Ace made outside the loop (the chat, MCP).
export type ChangeAuthor =
  | { actor: 'user'; reason: string | null }
  | { actor: 'ace'; reason: string | null; evidence: AceEvidence | null }

export const changeReasonSchema = z.string().min(1).max(300)

// A person in the Web UI is the user; everything else acting through the API
// (chat, MCP, a schedule, the hosted stages) is Ace.
export function authorOf(caller: 'browser' | 'agent', reason: string | null, signals: ChangeSignal[] | null = null): ChangeAuthor {
  return caller === 'browser' ? { actor: 'user', reason } : { actor: 'ace', reason, evidence: signals && { signals: [...new Set(signals)] } }
}

export function isDocumentTarget(slug: string): slug is DocumentTarget {
  return slug === 'business' || slug === 'sales_strategy'
}

// The settings that decide whom the project reaches and how. Nothing else
// keeps their past values, so their row carries what changed.
export type ReachSettings = {
  outboundChannels: OutboundChannel[]
  targetCountries: string[]
  targetLanguage: Locale
}
export type ReachDiff = { [K in keyof ReachSettings]?: { from: ReachSettings[K]; to: ReachSettings[K] } }

// No channel is a pause; no country limit is any country.
export const channelList = (values: readonly string[]): string => (values.length === 0 ? 'none' : values.join(', '))
export const countryList = (values: readonly string[]): string => (values.length === 0 ? 'any' : values.join(', '))

export function reachLine(diff: ReachDiff): string {
  return [
    diff.outboundChannels && `Channels: ${channelList(diff.outboundChannels.from)} → ${channelList(diff.outboundChannels.to)}`,
    diff.targetCountries && `Countries: ${countryList(diff.targetCountries.from)} → ${countryList(diff.targetCountries.to)}`,
    diff.targetLanguage && `Language: ${diff.targetLanguage.from} → ${diff.targetLanguage.to}`,
  ].filter(Boolean).join('; ')
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

export function reachDiff(before: ReachSettings, patch: Partial<ReachSettings>): ReachDiff {
  const diff: ReachDiff = {}
  if (patch.outboundChannels !== undefined && !sameSet(before.outboundChannels, patch.outboundChannels)) {
    diff.outboundChannels = { from: before.outboundChannels, to: patch.outboundChannels }
  }
  if (patch.targetCountries !== undefined && !sameSet(before.targetCountries, patch.targetCountries)) {
    diff.targetCountries = { from: before.targetCountries, to: patch.targetCountries }
  }
  if (patch.targetLanguage !== undefined && before.targetLanguage !== patch.targetLanguage) {
    diff.targetLanguage = { from: before.targetLanguage, to: patch.targetLanguage }
  }
  return diff
}

type OptionState = { archived: boolean; content: Record<string, string | null> }

// A state flip wins over a content edit in the same write; an option created
// archived logs both, so every archived option has its archive row.
export function optionOps(before: OptionState | null, after: OptionState): OptionOp[] {
  if (before === null) return after.archived ? ['add', 'archive'] : ['add']
  if (before.archived !== after.archived) return [after.archived ? 'archive' : 'restore']
  return Object.keys(after.content).some((k) => before.content[k] !== after.content[k]) ? ['update'] : []
}

type RuleChange = { target: OptionTarget; optionId: string; evidence: RuleEvidence | null } & (
  | { op: 'archive'; reason: RuleArchiveReason }
  | { op: 'restore' }
)

type Logged = { day: string; actor: ChangeAuthor['actor']; reason: string | null; evidence: AceEvidence | null }

// `day` is the UTC day the change was made.
export type LoggedChange =
  | ({ day: string; actor: 'rule' } & RuleChange)
  | (Logged & { target: OptionTarget; optionId: string; op: OptionOp })
  | (Logged & { target: DocumentTarget })
  | (Logged & { target: 'settings'; diff: ReachDiff })
  | (Logged & { target: 'frame' })
export type LoggedRuleChange = Extract<LoggedChange, { actor: 'rule' }>

// The rule reads only the reply rates; null for a change outside the loop.
export function changeSignals(c: LoggedChange): readonly ChangeSignal[] | null {
  return c.actor === 'rule' ? ['replies'] : c.evidence?.signals ?? null
}
