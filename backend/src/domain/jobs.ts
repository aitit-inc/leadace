// A job is one unit of the hosted agent's work — a stage of the daily cycle
// (or the whole cycle) run server-side as a Cloudflare Workflow instance.
// Every entry point (cron, chat, Web UI, MCP) creates the same row and the
// same instance, so a stage has exactly one implementation.
import { z } from 'zod'
import { discoveryStrategySchema, positiveInt } from './ids'
import { utcDateKey } from './time'

export const JOB_KINDS = ['daily_cycle', 'discover', 'enrich', 'draft', 'send', 'evaluate', 'journal'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled']

export const JOB_ORIGINS = ['cron', 'chat', 'ui', 'mcp'] as const
export type JobOrigin = (typeof JOB_ORIGINS)[number]

// Five signals × three stays within url_context's 20 URLs per request.
export const SIGNAL_MAX_SOURCES = 3
export const signalSourceSchema = z.url({ protocol: /^https?$/ }).max(500)

export const discoverSignalSchema = z.object({
  text: z.string().max(300),
  sourceUrls: z.array(signalSourceSchema).min(1).max(SIGNAL_MAX_SOURCES),
})

export const SIGNAL_MAX_AGE_DAYS = 90
const DAY_MS = 86_400_000

export function signalWindowStart(now: Date): string {
  return utcDateKey(new Date(now.getTime() - SIGNAL_MAX_AGE_DAYS * DAY_MS))
}

export function isRecentSignal(text: string, now: Date): boolean {
  const date = text.slice(0, 10)
  const at = new Date(date)
  // Date rolls 2026-02-30 over to March 2; only a real date round-trips.
  if (Number.isNaN(at.getTime()) || utcDateKey(at) !== date) return false
  return date <= utcDateKey(now) && date >= signalWindowStart(now)
}

// A discover candidate before enrichment: what a search surfaces about an
// organization, no contact data yet. Carried from discover into enrich.
export const discoverCandidateSchema = z.object({
  name: z.string().min(1).max(200),
  organizationName: z.string().min(1).max(200),
  websiteUrl: z.url().max(500),
  overview: z.string().min(1).max(2000),
  industry: z.string().min(1).max(120),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  employeeBand: z.enum(['1-10', '11-50', '51-200', '201+']).optional(),
  matchReason: z.string().min(1).max(1000),
  // Where the qualifying Prerequisite is observable; without it no later stage
  // can check the match.
  matchSourceUrls: z.array(signalSourceSchema).max(SIGNAL_MAX_SOURCES).default([]),
  priority: z.literal([1, 2, 3, 4, 5]),
  discoveryStrategy: discoveryStrategySchema.optional(),
  // Unconfirmed claims; enrich keeps only the ones their pages state.
  signals: z.array(discoverSignalSchema).max(5).default([]),
})
export type DiscoverCandidate = z.infer<typeof discoverCandidateSchema>

export const jobParamsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily_cycle'),
    outboundCount: z.number().int().min(1).max(200).default(30),
  }),
  z.object({
    kind: z.literal('discover'),
    count: z.number().int().min(1).max(100).default(10),
    // Pin one registered strategy instead of following the tick's batch plan.
    strategySlug: discoveryStrategySchema.optional(),
    // Set by the unattended cycle only, so a person's count is never lifted.
    minCandidatesPerSearch: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    kind: z.literal('enrich'),
    candidates: z.array(discoverCandidateSchema).min(1).max(100),
  }),
  z.object({
    kind: z.literal('draft'),
    // Either the next N reachable prospects or an explicit set.
    count: z.number().int().min(1).max(200).optional(),
    prospectIds: z.array(positiveInt).min(1).max(200).optional(),
  }).refine((p) => (p.count === undefined) !== (p.prospectIds === undefined), {
    message: 'exactly one of count or prospectIds',
  }),
  z.object({
    kind: z.literal('send'),
    draftIds: z.array(positiveInt).min(1).max(200),
  }),
  z.object({ kind: z.literal('evaluate') }),
  z.object({ kind: z.literal('journal') }),
])
export type JobParams = z.infer<typeof jobParamsSchema>
export type JobParamsOf<K extends JobKind> = Extract<JobParams, { kind: K }>

export type JobProgress = {
  step: string
  done: number
  total: number | null
}

// Per-kind outcome. `summary` is the one line a person (or the chat agent)
// reads; the structured fields let the UI and the daily cycle branch.
export type JobResult =
  | { kind: 'discover'; summary: string; found: number; fresh: number; registered: number; skipped: number; planCompliance: Array<{ slug: string; planned: number; found: number }> }
  | { kind: 'enrich'; summary: string; registered: number; skipped: number; withEmail: number }
  | { kind: 'draft'; summary: string; drafted: number; sent: number; skipped: number; failed: number; needsHands: number; variantIds: string[] }
  | { kind: 'send'; summary: string; sent: number; failed: number }
  | { kind: 'evaluate'; summary: string; report: string; wrote: string[] }
  | { kind: 'journal'; summary: string; saved: boolean }
  | { kind: 'daily_cycle'; summary: string }

type ProspectOutcome =
  | { outcome: 'registered'; prospectId: number }
  | { outcome: 'sent' | 'drafted'; subject: string }
  | { outcome: 'skipped' | 'failed'; reason: string }
  | { outcome: 'needs_hands' }

// Appended as each piece of work finishes, so a running job shows how far it
// got; `progress` is only where it is right now.
export type JobLogEntry =
  | { kind: 'stage'; stage: JobKind; summary: string }
  | { kind: 'decision'; text: string }
  | ({ kind: 'prospect'; name: string } & ProspectOutcome)
export type JobLogLine = JobLogEntry & { at: string; step: string }
