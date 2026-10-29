import { z } from 'zod'
import { OUTBOUND_CHANNELS, type OutboundChannel } from '../outbound-channel'
import { ALLOWED_SEND_COUNTRIES, type AllowedSendCountry } from '../country'
import { discoveryStrategySchema } from '../ids'
import { localeSchema } from '../locale'
import { sectionEditSchema } from '../document-sections'
import { changeReasonSchema, reachDiff, reachLine, type ChangeSignal, type ReachDiff, type ReachSettings } from './change'

// What Ace hands the person to decide (product_principles §2.2). A loosening or
// a new frame applies as written on its day unless the person stops it: no
// model runs at apply time. A means that needs the person's account waits for
// them and is applied once its playbook is approved.
export const PROPOSAL_WINDOW_DAYS = 1

export const PROPOSAL_STATUSES = ['pending', 'applied', 'stopped', 'outdated'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

// A channel or a country added, or the country limit lifted ([]). `from` is the
// setting it was written against.
export type ReachLoosening = Pick<ReachDiff, 'outboundChannels' | 'targetCountries'>

export type FrameVariant = { variantId: string; label: string; subjectPattern: string; bodyApproach: string }
export type FrameStrategy = { slug: string; approach: string }

// The outer layer's change: who to reach and what to lead with (the full sales
// strategy, as its edits leave it), on which channels, in which countries and
// language, and the options that test it. Every active option not in it is
// archived, and measuring restarts when it applies.
export type Frame = { salesStrategy: string; reach: ReachSettings; variants: FrameVariant[]; strategies: FrameStrategy[] }

export const frameBodySchema = z.object({
  salesStrategyEdits: z.array(sectionEditSchema).describe('The sales strategy sections the frame changes; every other section stays as it is'),
  outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).min(1).describe('The channels'),
  targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).describe('The countries ([] for any)'),
  targetLanguage: localeSchema.describe('The outreach language'),
  variants: z.array(z.object({
    label: z.string().min(1).max(120),
    subjectPattern: z.string().min(1).max(80),
    bodyApproach: z.string().min(1).max(2000),
  })).min(2).describe('The angles that test the frame'),
  strategies: z.array(z.object({ slug: discoveryStrategySchema, approach: z.string().min(1).max(2000) })).min(2)
    .describe('The search strategies for the frame, on slugs the project has not used'),
  reason: changeReasonSchema.describe('Why, one short line for the change log'),
})
export type FrameBody = z.infer<typeof frameBodySchema>

// Bounds kept off frameBodySchema: the model's frame answer shares it
// (services/loop/propose.ts), and they would change what it is asked for.
const { shape: frameShape } = frameBodySchema
export const frameRequestSchema = frameBodySchema.extend({
  salesStrategyEdits: frameShape.salesStrategyEdits.max(50),
  outboundChannels: frameShape.outboundChannels.max(OUTBOUND_CHANNELS.length),
  targetCountries: frameShape.targetCountries.max(ALLOWED_SEND_COUNTRIES.length),
  variants: frameShape.variants.max(20),
  strategies: frameShape.strategies.max(20),
})

export type ProposedChange =
  | ({ kind: 'loosen'; applyOn: string; reason: string } & ReachLoosening)
  // Written against sales_strategy version `salesStrategyFrom` and the reach
  // `reachFrom`.
  | ({ kind: 'frame'; applyOn: string; reason: string; salesStrategyFrom: number; reachFrom: ReachSettings } & Frame)
  | { kind: 'add-means'; strategy: string; instruction: string }

type Limits = { outboundChannels: readonly OutboundChannel[]; targetCountries: readonly string[] }

const covers = (wider: readonly string[], narrower: readonly string[]): boolean => narrower.every((v) => wider.includes(v))
const sorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort()
const sameSet = (a: readonly string[], b: readonly string[]): boolean => sorted(a).join() === sorted(b).join()

// The change as it would apply to `current`, or null when it loosens nothing.
// No channel at all is the person's pause, never Ace's to lift; no country
// limit is already the widest.
export function loosening(
  current: Limits,
  proposed: { outboundChannels: OutboundChannel[] | null; targetCountries: AllowedSendCountry[] | null },
): ReachLoosening | null {
  const change: ReachLoosening = {}
  if (proposed.outboundChannels !== null) {
    const to = sorted(proposed.outboundChannels)
    if (current.outboundChannels.length === 0 || !covers(to, current.outboundChannels)) return null
    if (!sameSet(to, current.outboundChannels)) change.outboundChannels = { from: sorted(current.outboundChannels), to }
  }
  if (proposed.targetCountries !== null) {
    const to = sorted(proposed.targetCountries)
    if (current.targetCountries.length === 0) return null
    if (to.length > 0 && !covers(to, current.targetCountries)) return null
    if (!sameSet(to, current.targetCountries)) change.targetCountries = { from: sorted(current.targetCountries), to }
  }
  return change.outboundChannels === undefined && change.targetCountries === undefined ? null : change
}

// False once anyone changed a setting the proposal was written against.
export function stillApplies(change: ReachLoosening, current: Limits): boolean {
  return (change.outboundChannels === undefined || sameSet(change.outboundChannels.from, current.outboundChannels))
    && (change.targetCountries === undefined || sameSet(change.targetCountries.from, current.targetCountries))
}

export function sameReach(a: ReachSettings, b: ReachSettings): boolean {
  return sameSet(a.outboundChannels, b.outboundChannels) && sameSet(a.targetCountries, b.targetCountries) && a.targetLanguage === b.targetLanguage
}

// No channel is the person's pause: a frame never lifts one.
export function frameReach(current: ReachSettings, frame: ReachSettings): ReachSettings {
  return {
    outboundChannels: current.outboundChannels.length === 0 ? [] : frame.outboundChannels,
    targetCountries: frame.targetCountries,
    targetLanguage: frame.targetLanguage,
  }
}

export function freshVariantIds(taken: ReadonlySet<string>, today: string, n: number): string[] {
  const prefix = `frame_${today.replace(/-/g, '')}_`
  const ids: string[] = []
  for (let k = 1; ids.length < n; k++) if (!taken.has(`${prefix}${k}`)) ids.push(`${prefix}${k}`)
  return ids
}

// A loosening rests on whom discovery found but cannot reach; a frame on its
// positive rate.
export function proposalSignals(change: Extract<ProposedChange, { kind: 'loosen' | 'frame' }>): ChangeSignal[] {
  return change.kind === 'loosen' ? ['discovery'] : ['replies']
}

export function applyOnFor(today: string): string {
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + PROPOSAL_WINDOW_DAYS)
  return day.toISOString().slice(0, 10)
}

export function proposalWhat(change: ProposedChange): string {
  switch (change.kind) {
    case 'loosen':
      return reachLine(change)
    case 'frame':
      return ['a new frame: sales strategy rewritten', reachLine(reachDiff(change.reachFrom, change.reach)), `${change.variants.length} angles`, `${change.strategies.length} search strategies`]
        .filter(Boolean).join('; ')
    case 'add-means':
      return `set up the means ${change.strategy}`
  }
}
