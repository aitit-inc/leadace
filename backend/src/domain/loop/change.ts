import { z } from 'zod'

// One policy_changes row per change to an option or a policy document. The
// tick's daily reweighting is not in it; that is lever_decisions.
export const POLICY_TARGETS = ['variant', 'strategy', 'business', 'sales_strategy'] as const
type PolicyTarget = (typeof POLICY_TARGETS)[number]
export type OptionTarget = Extract<PolicyTarget, 'variant' | 'strategy'>
export type DocumentTarget = Extract<PolicyTarget, 'business' | 'sales_strategy'>

export const POLICY_OPS = ['add', 'update', 'archive', 'restore'] as const
export type OptionOp = (typeof POLICY_OPS)[number]

export const POLICY_ACTORS = ['rule', 'ace', 'user'] as const
type PolicyActor = (typeof POLICY_ACTORS)[number]

export const RULE_ARCHIVE_REASONS = ['lost', 'rotated'] as const
export type RuleArchiveReason = (typeof RULE_ARCHIVE_REASONS)[number]
// The probability the rule held against its threshold: P(it beats the leader)
// for a lost or restored option; P(best) among the active set for a rotation
// and for every archive from before the leader test. Absent on archives the
// tick made before it recorded any.
export type RuleEvidence = { n: number } & ({ pBest: number } | { pBeatsLeader: number })

export type ChangeAuthor = { actor: Exclude<PolicyActor, 'rule'>; reason: string | null }

export const changeReasonSchema = z.string().min(1).max(300)

// A person in the Web UI is the user; everything else acting through the API
// (chat, MCP, a schedule, the hosted stages) is Ace.
export function authorOf(caller: 'browser' | 'agent', reason: string | null): ChangeAuthor {
  return { actor: caller === 'browser' ? 'user' : 'ace', reason }
}

export function isDocumentTarget(slug: string): slug is DocumentTarget {
  return slug === 'business' || slug === 'sales_strategy'
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

// `day` is the UTC day the change was made.
export type LoggedChange =
  | ({ day: string; actor: 'rule' } & RuleChange)
  | { day: string; actor: ChangeAuthor['actor']; target: OptionTarget; optionId: string; op: OptionOp; reason: string | null }
  | { day: string; actor: ChangeAuthor['actor']; target: DocumentTarget; reason: string | null }
export type LoggedRuleChange = Extract<LoggedChange, { actor: 'rule' }>
