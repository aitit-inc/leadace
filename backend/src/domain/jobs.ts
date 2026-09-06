// A job is one unit of the hosted agent's work — a stage of the daily cycle
// (or the whole cycle) run server-side as a Cloudflare Workflow instance.
// Every entry point (cron, chat, Web UI, MCP) creates the same row and the
// same instance, so a stage has exactly one implementation.
import { z } from 'zod'
import { discoveryStrategySchema, positiveInt } from './ids'

export const JOB_KINDS = ['daily_cycle', 'discover', 'enrich', 'draft', 'send', 'evaluate', 'journal'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled']

export const JOB_ORIGINS = ['cron', 'chat', 'ui', 'mcp'] as const
export type JobOrigin = (typeof JOB_ORIGINS)[number]

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
  priority: z.literal([1, 2, 3, 4, 5]),
  discoveryStrategy: discoveryStrategySchema.optional(),
  // Dated, sourced signals the search itself surfaced ("2026-03-12: Series B (TechCrunch)").
  signals: z.array(z.string().max(300)).max(5).default([]),
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
  | { kind: 'enrich'; summary: string; registered: number; skipped: number; withEmail: number; skippedDetails: Array<{ name: string; reason: string }> }
  | { kind: 'draft'; summary: string; drafted: number; sent: number; skipped: number; failed: number; needsHands: number; variantIds: string[] }
  | { kind: 'send'; summary: string; sent: number; failed: number }
  | { kind: 'evaluate'; summary: string; report: string; wrote: string[] }
  | { kind: 'journal'; summary: string; saved: boolean }
  | { kind: 'daily_cycle'; summary: string; stages: Array<{ kind: JobKind; summary: string }>; decisions: string[] }
