import * as Sentry from '@sentry/cloudflare'
import { sentryOptions } from '../sentry'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { verifyJwt, verifySupabaseJwt } from '../auth/verify-jwt'
import { BUG_REPORT_CATEGORIES, OUTBOUND_MODES, OUTBOUND_CHANNELS, REJECTION_PRIMARY_REASONS, REJECTION_RECONTACT_WINDOWS, prospectStatusEnum, prioritySchema } from '../db/schema'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'
import { variantIdSchema } from '../domain/ids'
import type { OutreachQuota, OutreachQuotaWindow } from '../services/plan-limits'
import {
  handleMetadata,
  handleResourceMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizeSessionInfo,
  handleAuthorizeFinalize,
  handleToken,
  handleRevoke,
  handleListSessions,
  handleRevokeSession,
  fingerprint,
  MCP_ACCESS_TOKEN_AUDIENCE,
} from './oauth'

import {
  isHttpsUrl,
  isHttpOrHttpsUrl,
  HTTPS_ONLY_MSG,
  HTTP_OR_HTTPS_ONLY_MSG,
} from '../domain/url'

type Env = {
  WEB_API_URL: string
  SUPABASE_JWT_SECRET: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  ENVIRONMENT: string
  FRONTEND_URL: string
  MCP_OAUTH_STORE: KVNamespace
  // Cloud-only error tracking. Worker secret on the hosted deploy; unset for
  // local dev / self-host, where Sentry is a no-op.
  SENTRY_DSN?: string
}

// SERVER_VERSION is informational — the deployed backend's own version.
// MIN_PLUGIN_VERSION is the gate: any plugin older than this MUST be told to
// run `/plugin update leadace@leadace` because backend behavior assumes the
// new plugin contract. Bump this **only when** introducing a backend change
// that the old plugin cannot tolerate (removed tool, renamed required arg,
// changed response shape). See .claude/rules/release.md.
const SERVER_VERSION = '1.0.0'
// 0.6.16 hard-cuts < 0.6.16 plugins because the evaluations table was dropped:
// `get_evaluation_history` was removed (old `/evaluate`, `/daily-cycle`,
// `/leadace` SKILL.md still call it) and `record_evaluation` now requires a
// non-empty `priorityUpdates` (old skills also passed metrics/findings/
// improvements and, on the insufficient-data path, no priorities at all → 400).
const MIN_PLUGIN_VERSION = '0.6.16'

async function extractUserId(request: Request, jwtSecret: string, supabaseUrl?: string): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  return verifySupabaseJwt(token, jwtSecret, supabaseUrl)
}

// Variant that refuses MCP-minted access tokens. Used by Settings-facing
// surfaces (/sessions*) so an authorized MCP client cannot enumerate or
// revoke the user's other MCP sessions on their behalf — that management
// surface is intended for the browser session only.
async function extractSupabaseUserId(request: Request, jwtSecret: string, supabaseUrl?: string): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const verified = await verifyJwt(token, jwtSecret, supabaseUrl)
  if (!verified) return null
  if (verified.aud === MCP_ACCESS_TOKEN_AUDIENCE) return null
  return verified.sub
}

async function callApi(
  method: string,
  path: string,
  body: unknown,
  apiUrl: string,
  authHeader: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${apiUrl}/api${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

const formatTarget = (id?: string) => id ? `project ${id}` : 'tenant assets'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
}

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders)) {
    newHeaders.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

type ToolCtx = { apiUrl: string; authHeader: string }

type ToolDef = {
  name: string
  description: string
  schema: z.ZodRawShape
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<CallToolResult> | CallToolResult
}

// The tool catalog (names, descriptions, input schemas, handlers) is immutable
// and built once per isolate here. Only the per-request execution context
// (apiUrl, authHeader) varies — createMcpServer injects it at call time. Building
// the tool schemas once instead of per request keeps the MCP fetch path off the
// Worker CPU limit (per-request rebuild used to exceed Free's 10 ms ceiling).
function buildToolRegistry(): ToolDef[] {
  const tools: ToolDef[] = []
  const defineTool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => Promise<CallToolResult> | CallToolResult,
  ): void => {
    tools.push({ name, description, schema, handler: handler as ToolDef['handler'] })
  }

  defineTool(
    'get_server_version',
    'Return the LeadAce backend MCP server version and the minimum compatible plugin version. Skills should call this first and abort with a "/plugin update" message if their plugin.json version is below minPluginVersion.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ serverVersion: SERVER_VERSION, minPluginVersion: MIN_PLUGIN_VERSION }),
        }],
      }
    },
  )

  defineTool(
    'report_bug',
    'File a bug, feedback, or idea about LeadAce. The maintainer reviews these out of band on the LeadAce backend (no public issue is opened). Use freely from any skill — include what you tried, what happened, and what you expected. The optional `context` field accepts arbitrary JSON metadata (skill name, plugin version, prospect/project ids, etc.). Daily-capped per tenant; on cap exhaustion the call returns an error and the user can retry tomorrow. self-host installs collect reports in their own database (the maintainer does not see them).',
    {
      category: z.enum(BUG_REPORT_CATEGORIES)
        .describe('"bug" = something is broken / wrong. "feedback" = working but rough / confusing. "idea" = a feature request or product suggestion.'),
      title: z.string().min(3).max(200)
        .describe('One-line summary, e.g. "/check-responses crashes when no Gmail connected".'),
      body: z.string().min(10).max(4000)
        .describe('What you tried, what happened, what you expected. Include reproduction steps if you have them.'),
      context: z.record(z.string(), z.unknown()).optional()
        .describe('Optional structured metadata (any JSON object). Suggested keys: skill, pluginVersion, projectId, prospectId, errorMessage.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/bug-reports', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Reported. Thanks — the maintainer will review it.` }] }
    },
  )

  defineTool(
    'list_projects',
    'List all projects for the current user.',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/projects', null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { projects } = data as { projects: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: projects.length === 0
            ? 'No projects found.'
            : `${projects.length} project(s).\n${JSON.stringify(projects, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'setup_project',
    'Create a new LeadAce project. Returns the auto-generated project ID. Returns an error if the plan limit is reached.',
    { name: z.string().describe('Project name (unique per tenant)') },
    async ({ name }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/projects', { name }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}${err.detail ? ` — ${err.detail}` : ''}` }], isError: true }
      }
      const result = data as { id: string; name: string }
      return { content: [{ type: 'text' as const, text: `Project "${name}" created (id: ${result.id}).` }] }
    },
  )

  defineTool(
    'delete_project',
    'Delete a project and its project-scoped data (project-prospect links, outreach logs, responses, documents, settings, subject variants). Prospects themselves are tenant assets and are NOT deleted — they survive for other projects and /match-prospects.',
    { projectId: z.string().min(1).describe('Project name or ID') },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('DELETE', `/projects/${encodeURIComponent(projectId)}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Project "${projectId}" deleted.` }] }
    },
  )

  defineTool(
    'add_prospects',
    'Batch register prospects. Server-side dedup is the single source of truth for duplicate avoidance. Each skipped row comes back in skippedDetails as {name, reason} where reason ∈ "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch" | "plan_limit". Use those codes to adjust your search keywords (e.g. lots of "email_duplicate" → narrow the search; lots of "already_in_project" → cluster is exhausted). projectId is optional: omit it to save prospects as tenant-only assets (no project link). When projectId is provided, every prospect must include matchReason. Set doNotContact=true on rows the source data marks as unsubscribed/opted-out so /build-list will not re-contact them later (DNC is a one-way ratchet on overwrite — false never clears an existing flag). Pair tenant-only imports with /match-prospects to link the right ones into a project later.',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID. Omit to save prospects as tenant-only assets without linking to any project.'),
      prospects: z.array(z.object({
        organizationDomain: z.string().describe('Organization domain. Apex form preferred (e.g. example.com); raw URLs and "www." prefix are tolerated and normalized server-side.'),
        organizationName: z.string(),
        organizationWebsiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
        name: z.string().describe('Prospect name (company, school, department, etc.)'),
        contactName: z.string().optional(),
        department: z.string().optional(),
        overview: z.string(),
        industry: z.string().optional(),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
        email: z.email().optional().describe('At least one contact channel required'),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        formType: z.enum(['google_forms', 'native_html', 'wordpress_cf7', 'iframe_embed', 'with_captcha']).optional(),
        snsAccounts: z.object({
          x: z.string().optional(),
          linkedin: z.string().optional(),
          instagram: z.string().optional(),
          facebook: z.string().optional(),
        }).optional(),
        notes: z.string().optional(),
        hypothesis: z.object({
          targetDepartment: z.string().optional().describe('Likely buyer department (e.g. "RevOps", "Sales Engineering").'),
          targetRolePattern: z.string().optional().describe('Likely buyer role pattern (e.g. "Director of Sales Ops").'),
          hypothesizedPain: z.array(z.string()).optional().describe('Short pain hypotheses for this prospect (bullets, ≤3 items).'),
          valueMapping: z.array(z.string()).optional().describe('How our offering addresses each pain (bullets, same order as hypothesizedPain when paired).'),
          timingSignals: z.array(z.string()).optional().describe('Concrete reasons NOW is a good moment (recent press, hiring, funding, signals from overview ## Recent Signals).'),
          bestChannel: z.string().optional().describe('Suggested first channel (e.g. "personal_email", "form", "linkedin_dm").'),
          bestKeyperson: z.string().optional().describe('Specific keyperson handle if obvious from public info (name + role).'),
        }).optional().describe('Per-prospect targeting hypothesis. Read by the inquiry-landing chat snapshot to ground responses about the visiting org. All fields optional — partial hypothesis still helps.'),
        doNotContact: z.boolean().optional().describe('Mark this prospect as do-not-contact (unsubscribed / opted-out). Defaults to false. On overwrite, true sets the flag but false never clears an existing one.'),
        matchReason: z.string().optional().describe('Why this prospect is a good target. Required when projectId is set; ignored otherwise.'),
        priority: prioritySchema.default(3),
        country: z.string().regex(/^[A-Z]{2}$/).optional().describe('Per-prospect country override (ISO 3166-1 alpha-2). Usually unset — the org country (with TLD inference fallback) covers the typical case. Outreach currently only delivers to US / CA / JP recipients; other codes register fine but are blocked at outreach time.'),
        countrySource: z.enum(['manual', 'ai_inferred']).optional().describe('How the country value was determined. "manual" = operator confirmed; "ai_inferred" = LLM-derived from page content. Only meaningful when country is provided.'),
      })).describe('Array of prospects to register (max 100)'),
    },
    async ({ projectId, prospects }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/prospects/batch', { projectId, prospects }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { inserted: number; skipped: number; insertedIds: number[]; skippedDetails: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: `Registered (${formatTarget(projectId)}): ${result.inserted}, Skipped: ${result.skipped}\nSkipped details: ${JSON.stringify(result.skippedDetails)}`,
        }],
      }
    },
  )

  defineTool(
    'check_prospect_dedup',
    'Read-only pre-flight duplicate check. Use after candidate discovery, before paying for heavy contact retrieval: pass each candidate\'s organizationDomain (and email / contactFormUrl if surfaced incidentally), receive {kind: "fresh" | "skip", reason?} per candidate in input order. Skip reasons are the dedup-only subset of add_prospects: "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch". add_prospects also emits "plan_limit" — that is a budget signal, never emitted here. Drop kind="skip" candidates before launching contact-retrieval sub-agents; add_prospects re-runs the same dedup as a safety net. Up to 100 candidates per call.',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID. Omit for tenant-scope dedup only (no project-link check).'),
      candidates: z.array(z.object({
        organizationDomain: z.string().describe('Organization domain. Apex form preferred (e.g. example.com); raw URLs and "www." prefix are tolerated and normalized server-side. Required.'),
        email: z.email().optional(),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
      })).describe('Array of candidates to check (max 100)'),
    },
    async ({ projectId, candidates }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/prospects/check-dedup', { projectId, candidates }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { decisions: Array<{ kind: 'fresh' | 'skip'; reason?: string }> }
      const fresh = result.decisions.filter((d) => d.kind === 'fresh').length
      const skip = result.decisions.length - fresh
      return {
        content: [{
          type: 'text' as const,
          text: `Checked ${result.decisions.length} (${formatTarget(projectId)}): ${fresh} fresh, ${skip} skip.\nDecisions: ${JSON.stringify(result.decisions)}`,
        }],
      }
    },
  )

  defineTool(
    'import_prospects_from_csv',
    'Import prospects from a canonical CSV string. Required headers: organizationDomain, organizationName, organizationWebsiteUrl, name, overview, websiteUrl. matchReason is required only when projectId is provided. Optional headers: contactName, department, industry, email, contactFormUrl, formType, snsAccounts.x, snsAccounts.linkedin, snsAccounts.instagram, snsAccounts.facebook, notes, priority, doNotContact, country (ISO 3166-1 alpha-2; see list_country_codes), countrySource (manual | ai_inferred). At least one of email / contactFormUrl / snsAccounts.* per row. doNotContact accepts 1/true/yes/on (DNC) or 0/false/no/off (not DNC); empty cells are treated as not provided. Set it on rows the source marks as unsubscribed/opted-out so /build-list will not re-discover and contact them. On overwrite, doNotContact=true sets the flag on existing prospects; false (or column absent) never clears an existing flag (one-way ratchet). projectId is optional: omit it to save prospects as tenant-only assets (no project_prospects link is created — pair with /match-prospects to link them into a project later). dedupPolicy "skip" leaves existing prospects alone; "overwrite" updates prospect fields (matched by email or contactFormUrl) and re-links to the project. Rows that match only by organization domain are skipped as "already_in_project" even with "overwrite" — the prospect identity within that organization is ambiguous and cannot be safely updated. Existing prospects already flagged do_not_contact are always skipped (their record is preserved). Skipped rows are returned in skippedDetails as {row, name, reason} where reason ∈ "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch" | "plan_limit". Max 1000 data rows.',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID. Omit to save prospects as tenant-only assets without linking to any project.'),
      csvText: z.string().describe('Full CSV text including header row'),
      dedupPolicy: z.enum(['skip', 'overwrite']).default('skip'),
    },
    async ({ projectId, csvText, dedupPolicy }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'POST',
        '/prospects/import',
        { projectId, csvText, dedupPolicy },
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as {
        inserted: number
        overwritten: number
        skipped: number
        errors: number
        skippedDetails: unknown[]
        errorDetails: unknown[]
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Imported (${formatTarget(projectId)}): ${result.inserted} new, ${result.overwritten} overwritten, ${result.skipped} skipped, ${result.errors} errors.\nSkipped: ${JSON.stringify(result.skippedDetails)}\nErrors: ${JSON.stringify(result.errorDetails)}`,
        }],
      }
    },
  )

  defineTool(
    'list_country_codes',
    'List the country codes LeadAce recognizes for a prospect / organization `country` field (ISO 3166-1 alpha-2). Returns { countries: [{ code, name, sendAllowed }], sendAllowed, note }; sendAllowed marks the codes outreach can currently deliver to. Any other two-letter code still stores fine but is blocked at send time. Use it to present country choices in import / registration flows instead of inventing a list.',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/country-codes', null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'get_outbound_targets',
    'Get prospects due for outreach ordered by priority — new prospects plus already-contacted prospects due for a follow-up touch or a months-scale recycle. Each carries `country` (effective code = prospect override > org country > null) for pre-flight skipping against the currently-allowed US/CA/JP delivery scope, and a `cycle` object: cycle.kind is "first" | "short_cycle_followup" (a day-scale follow-up to an unanswered email — write a brief nudge with a varied subject and a fresh angle, never a resend) | "no_response" (the months-scale recycle, noResponseRecycleDays, default 90) | "rejection_followup", and cycle.touchNumber is which touch the next send is.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max number of prospects to return'),
    },
    async ({ projectId, limit }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/prospects/reachable?limit=${limit}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as {
        prospects: unknown[]
        total: number
        byChannel: { email: number; formOnly: number; snsOnly: number }
        quota?: OutreachQuota
        // Wire shape: Date fields arrive as ISO strings through res.json().
        mailboxQuota?:
          | { kind: 'no_mailbox' }
          | { kind: 'capped'; cap: number; used: number; remaining: number; pausedUntil: string | null }
        outboundMode: 'send' | 'draft'
        message?: string
      }

      const formatWindow = (label: string, w: OutreachQuotaWindow) =>
        `${label} ${w.remaining}/${w.limit} remaining (used ${w.used})`
      const quotaLine = (() => {
        if (!result.quota) return ''
        const q = result.quota
        if (q.kind === 'unlimited') return `\nOutreach quota: unlimited (plan: ${q.plan})`
        const parts: string[] = []
        if (q.daily) parts.push(formatWindow('daily', q.daily))
        if (q.lifetime) parts.push(formatWindow('lifetime', q.lifetime))
        if (q.monthly) parts.push(formatWindow('monthly', q.monthly))
        const summary = parts.length > 0 ? parts.join(', ') : `${q.remaining}/${q.limit} remaining (used ${q.used})`
        return `\nOutreach quota: ${summary} (plan: ${q.plan})`
      })()
      const mbq = result.mailboxQuota
      const mailboxLine =
        mbq && mbq.kind === 'capped'
          ? mbq.pausedUntil
            ? `\nMailbox email sending paused until ${mbq.pausedUntil}`
            : `\nMailbox email cap (warmup): ${mbq.remaining}/${mbq.cap} sends remaining today`
          : ''
      const msgLine = result.message ? `\n⚠️ ${result.message}` : ''
      const modeLine = `\nOutbound mode: ${result.outboundMode}`

      return {
        content: [{
          type: 'text' as const,
          text: `Total reachable: ${result.total} (email: ${result.byChannel.email}, formOnly: ${result.byChannel.formOnly}, snsOnly: ${result.byChannel.snsOnly})${modeLine}${quotaLine}${mailboxLine}${msgLine}\nReturned: ${result.prospects.length}\n${JSON.stringify(result.prospects, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'get_mailbox_health',
    'Read the warmup and safe-daily-cap state of the mailbox THIS PROJECT sends from. Resolves the project\'s sending identity (its assigned custom mailbox, else the connected Gmail), so the numbers match what the send path enforces — use it to explain a 403 "Mailbox daily send cap reached" for this project. Read-only. This per-mailbox EMAIL cap is a deliverability guardrail SEPARATE from the plan / billing outreach quota: it limits email sends only (form / SNS don\'t count) to protect the sending domain\'s reputation, applies on every plan and self-host, and resets at UTC midnight. Returns how far warmup has ramped (week X of N toward the steady-state cap) or the fixed daily cap override when one is set, today\'s cap / used / remaining, and any pause. Returns "no mailbox connected" when the project has no assigned mailbox and no Gmail is linked.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/mailbox-health`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.detail ? `${err.error}: ${err.detail}` : err.error}` }], isError: true }
      }
      // Wire shape: Date fields arrive as ISO strings through res.json().
      const h = data as
        | { kind: 'no_mailbox' }
        | {
            kind: 'active'
            email: string
            warmupStartedAt: string | null
            dailyCapOverride: number | null
            pausedUntil: string | null
            rampWeek: number
            rampWeeks: number
            steadyStatePerDay: number
            cap: number
            used: number
            remaining: number
          }
      if (h.kind === 'no_mailbox') {
        return { content: [{ type: 'text' as const, text: 'No sending mailbox connected. Connect a Gmail account at https://app.leadace.ai to enable email sends and warmup.' }] }
      }
      const warmupLine = h.dailyCapOverride !== null
        ? `fixed daily cap ${h.dailyCapOverride}/day (warmup ramp bypassed)`
        : h.rampWeek >= h.rampWeeks
          ? `warmup complete (steady ${h.steadyStatePerDay}/day)`
          : `warming up — week ${h.rampWeek} of ${h.rampWeeks} toward steady ${h.steadyStatePerDay}/day${h.warmupStartedAt ? '' : ' (no email sent yet)'}`
      const lines = [
        `Mailbox: ${h.email}`,
        `Cap: ${warmupLine}`,
        `Today (email only): ${h.used}/${h.cap} sent, ${h.remaining} remaining — resets at UTC midnight`,
      ]
      if (h.pausedUntil) lines.push(`⚠️ Sending PAUSED until ${h.pausedUntil}`)
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    },
  )

  defineTool(
    'record_outreach_with_inquiry',
    'Pre-submit allocation for form / SNS DM channels: reserves the outreach log row (status="pre_send" in send mode, "pending_review" in draft mode) and returns finalBody with the inquiry-landing URL footer baked in (when project_settings.inquiryLandingEnabled=true). The skill submits finalBody verbatim, then resolves the row by calling update_outreach_status with "sent" on success or "failed" on failure. The prospect is flipped to "contacted" only on the "sent" transition. In draft mode the user submits manually from app.leadace.ai/drafts — no follow-up call needed. For email use send_email_and_record instead.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['form', 'sns_twitter', 'sns_linkedin']),
      subject: z.string().optional(),
      body: z.string(),
      variantId: variantIdSchema.optional().describe('Subject variant id from pick_subject_variant. Stamps outreach_logs.variant_id so per-variant reply rates are not biased to email-only sends.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/outreach/record-with-inquiry', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { outreachLogId: number; status: 'pre_send' | 'pending_review'; finalBody: string; inquiryUrl: string | null }
      const url = result.inquiryUrl ? `\nInquiry URL: ${result.inquiryUrl}` : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Outreach allocated (id: ${result.outreachLogId}, status: ${result.status}).${url}\n\nfinalBody:\n${result.finalBody}`,
        }],
      }
    },
  )

  defineTool(
    'update_outreach_status',
    'Resolve a "pre_send" outreach log row allocated by record_outreach_with_inquiry. Call with status="sent" after the form / SNS submit succeeds — the server flips the prospect to "contacted" and confirms quota consumption. Call with status="failed" plus an errorMessage if the submit fails — the in-flight quota reservation is refunded and next_outreach_after is stamped to sentAt + noResponseRecycleDays so the prospect drops out of get_outbound_targets for that window (existing longer windows are preserved via GREATEST). Only the "pre_send" → terminal transition is accepted.',
    {
      outreachLogId: z.number().int().positive().describe('outreachLogs.id from record_outreach_with_inquiry.'),
      status: z.enum(['sent', 'failed']).describe('"sent" = submit succeeded; "failed" = submit failed.'),
      errorMessage: z.string().min(1).max(2000).optional().describe('Required when status="failed". Reason for the submit failure (HTTP status, network error, etc.).'),
    },
    async ({ outreachLogId, status, errorMessage }, { apiUrl, authHeader }) => {
      if (status === 'failed' && !errorMessage) {
        return { content: [{ type: 'text' as const, text: 'Error: errorMessage is required when status="failed".' }], isError: true }
      }
      const body = status === 'failed' ? { status, errorMessage } : { status }
      const { ok, data } = await callApi('PATCH', `/outreach/${outreachLogId}/status`, body, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Outreach ${outreachLogId} resolved as ${status}.` }] }
    },
  )

  defineTool(
    'get_tenant_settings',
    'Get the workspace-level identity / compliance fields the user has configured. Returns a readiness status line plus legalName, physicalAddress, and defaultSenderCountry. legalName / physicalAddress / defaultSenderCountry are MANDATORY for outbound sends — when any of those is null, send_email_and_record / record_outreach_with_inquiry refuse with 412. /leadace uses this to direct the user to the Workspace settings page when fields are missing.',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/tenant-settings', null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const r = data as {
        legalName: string | null
        physicalAddress: string | null
        defaultSenderCountry: string | null
      }
      const missing: string[] = []
      if (!r.legalName) missing.push('legalName')
      if (!r.physicalAddress) missing.push('physicalAddress')
      if (!r.defaultSenderCountry) missing.push('defaultSenderCountry')
      const status =
        missing.length === 0
          ? 'Compliance ready.'
          : `Missing required fields: ${missing.join(', ')}. Set them at https://app.leadace.ai/workspace-settings before outbound.`
      return {
        content: [{
          type: 'text' as const,
          text: `${status}\n\nlegalName: ${r.legalName ?? '(not set)'}\nphysicalAddress: ${r.physicalAddress ?? '(not set)'}\ndefaultSenderCountry: ${r.defaultSenderCountry ?? '(not set)'}`,
        }],
      }
    },
  )

  defineTool(
    'update_tenant_settings',
    'Update workspace-level identity / compliance fields. All fields are optional — only the keys you pass are written. legalName / physicalAddress / defaultSenderCountry are the three mandatory-for-outbound fields; setting them clears the 412 send-time refusal. defaultSenderCountry is the sender-side ISO 3166-1 alpha-2 code recorded in the compliance footer; any valid alpha-2 is accepted. It is independent from the recipient-delivery allowlist (which is enforced separately on prospect / organization country). Used by /leadace to interactively fill compliance during onboarding.',
    {
      name: z.string().min(1).max(120).optional().describe('Workspace display name (internal label).'),
      legalName: z.string().min(1).max(200).nullable().optional().describe('Registered business name shown in the email compliance footer (CAN-SPAM § 5(a)(5)).'),
      physicalAddress: z.string().min(5).max(500).nullable().optional().describe('Postal address shown in the email compliance footer (CAN-SPAM physical address requirement).'),
      defaultSenderCountry: z.string().regex(/^[A-Z]{2}$/, 'must be ISO 3166-1 alpha-2 (e.g. US, CA, JP)').nullable().optional(),
    },
    async (patch, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('PUT', '/tenant-settings', patch, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const r = data as { legalName: string | null; physicalAddress: string | null; defaultSenderCountry: string | null }
      const remaining: string[] = []
      if (!r.legalName) remaining.push('legalName')
      if (!r.physicalAddress) remaining.push('physicalAddress')
      if (!r.defaultSenderCountry) remaining.push('defaultSenderCountry')
      const status = remaining.length === 0
        ? 'Workspace settings updated. Compliance ready.'
        : `Workspace settings updated. Still missing: ${remaining.join(', ')}.`
      return { content: [{ type: 'text' as const, text: status }] }
    },
  )

  defineTool(
    'get_compliance_status',
    'Lightweight pre-flight check for outbound. Returns just { ready: boolean, missing: string[] } so callers can branch without parsing the full tenant settings payload. ready=false means at least one of legalName / physicalAddress / defaultSenderCountry is unset and any send_email_and_record / record_outreach_with_inquiry call will refuse with 412. Use this at the top of /outbound to bail early before spending tokens on draft generation.',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/tenant/compliance-status', null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const r = data as { ready: boolean; missing: string[] }
      const text = r.ready
        ? 'compliance_status: ready'
        : `compliance_status: incomplete\nmissing: ${r.missing.join(', ')}\nfix_url: https://app.leadace.ai/workspace-settings`
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  defineTool(
    'list_subject_variants',
    'List the project\'s subject-line variants (active + archived) so /leadace can detect whether seeding is needed and /evaluate can review existing rotation. Returns `{ variants: [{ variantId, subjectPattern, label, archivedAt, ... }] }` ordered by createdAt asc.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/subject-variants`, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { variants: Array<{ variantId: string; subjectPattern: string; label: string | null; archivedAt: string | null }> }
      const active = result.variants.filter((v) => !v.archivedAt)
      const archived = result.variants.filter((v) => v.archivedAt)
      return {
        content: [{
          type: 'text' as const,
          text: `Active: ${active.length}, archived: ${archived.length}.\n${JSON.stringify(result.variants, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'upsert_subject_variant',
    'Register or update a subject-line A/B variant on a project. variantId is a stable slug (e.g. "v1", "warm_intro", "signal_funded"); subjectPattern may include {{org}} / {{name}} / {{signal}} placeholders that the skill substitutes at send time. Setting archived=true retires the slug from rotation while keeping it analysable for historic outreach rows. Idempotent: re-calling with the same variantId updates the pattern / label / archived state. /leadace onboarding seeds the first 2-3 variants; /evaluate may suggest adding new ones based on response rates.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      variantId: variantIdSchema.describe('Stable slug, max 32 chars [A-Za-z0-9_-]'),
      subjectPattern: z.string().min(1).max(300).describe('Subject template; may use {{placeholders}}.'),
      label: z.string().min(1).max(120).nullable().optional().describe('Optional human-readable label for /evaluate.'),
      archived: z.boolean().optional().describe('Set true to retire the slug from rotation.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { projectId, ...body } = input
      const { ok, data } = await callApi(
        'PUT',
        `/projects/${encodeURIComponent(projectId)}/subject-variants`,
        body,
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { variantId: string; archivedAt: Date | null }
      const status = result.archivedAt ? 'archived' : 'active'
      return { content: [{ type: 'text' as const, text: `Subject variant ${result.variantId} saved (${status}).` }] }
    },
  )

  defineTool(
    'pick_subject_variant',
    'Pick an active subject-line variant for the project via a server-side weighted draw (weights are recomputed daily by run_lever_tick; an un-ticked / under-sampled project draws uniformly). Pass an explicit variantId to bypass the draw; unknown / archived ids fall through to the draw. Returns { variantId, subjectPattern, label }. For any subject-bearing send: the skill renders the pattern (substitutes {{org}} / {{name}} / {{signal}} placeholders) into the final subject and forwards variantId to send_email_and_record (email) or record_outreach_with_inquiry (a contact form that carries a subject) so outreach_logs.variant_id is stamped. NOT_FOUND when no active variants are registered — generate a one-off subject and send without variantId in that case.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      variantId: variantIdSchema.optional().describe('Override the weighted draw with a specific variant id.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const path = `/projects/${encodeURIComponent(input.projectId)}/subject-variants/pick${input.variantId ? `?variantId=${encodeURIComponent(input.variantId)}` : ''}`
      const { ok, data } = await callApi('POST', path, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { variantId: string; subjectPattern: string; label: string | null }
      const labelLine = result.label ? `\nLabel: ${result.label}` : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Picked variant: ${result.variantId}${labelLine}\nSubject pattern: ${result.subjectPattern}`,
        }],
      }
    },
  )

  defineTool(
    'run_lever_tick',
    'Run the daily outbound-optimization tick for the project. (1) Subject lines: measures per-variant reply rates over the reward-mature window, recomputes the weighted-draw weights pick_subject_variant reads, and archives any clearly-dominated variant (never below two active; reversible by un-archiving). (2) Channel affinity: measures (channel × coarse-industry) reply rates and recomputes the per-industry channel ranking get_outbound_targets surfaces — cells under min-sample stay on policy order, so low-volume projects are unaffected. Idempotent per UTC day — a second call the same day reports the already-recorded decision without re-applying. Call once per day from /daily-cycle after results are in. Returns the decision (subject weights, archived variants, sample counts, channel affinity by industry bucket) plus needsReplenishment: true when the subject pool has converged to the two-active floor with a dominated arm (the lever prunes/re-weights but never generates — /evaluate supplies a fresh angle).',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', `/projects/${encodeURIComponent(input.projectId)}/run-lever-tick`, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const r = data as {
        ran: boolean
        cycleDate: string
        minSamplePerArm: number
        weights: Record<string, number>
        archived: Array<{ variantId: string }>
        samples: Array<{ variantId: string; total: number }>
        channelAffinity: Record<string, Array<{ channel: string; rate: number; total: number; responses: number }>>
        needsReplenishment: boolean
      }
      const mature = r.samples.filter((s) => s.total >= r.minSamplePerArm).length
      const head = r.ran
        ? `Lever tick ran for ${r.cycleDate}.`
        : `Lever tick already ran for ${r.cycleDate} (no change).`
      const archivedLine = r.archived.length > 0 ? ` Archived: ${r.archived.map((a) => a.variantId).join(', ')}.` : ''
      const buckets = Object.keys(r.channelAffinity)
      const channelLine = buckets.length > 0
        ? `\nChannel affinity (${buckets.length} industry bucket(s)): ${JSON.stringify(r.channelAffinity)}`
        : '\nChannel affinity: none yet (cells under min-sample → policy order).'
      const replenishLine = r.needsReplenishment
        ? '\nReplenishment: pool converged to the floor with a dominated arm — /evaluate should supply one fresh subject angle.'
        : ''
      return {
        content: [{
          type: 'text' as const,
          text: `${head} ${mature}/${r.samples.length} variant(s) at min-sample (${r.minSamplePerArm}).${archivedLine}\nWeights: ${JSON.stringify(r.weights)}${channelLine}${replenishLine}`,
        }],
      }
    },
  )

  defineTool(
    'get_lever_state',
    'Inspect the outbound optimizer state for the project: current subject draw weights (null = no tick yet → uniform), the measured channel affinity per coarse-industry bucket ({} = none yet → policy order), when they were last updated, the mature sample progress per active variant, today\'s tick decision if it has run, and needsReplenishment (true when the pool has converged to the two-active floor with a dominated arm → /evaluate should supply one fresh subject angle). Read-only — use it to see whether optimization has enough data and what it last decided.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(input.projectId)}/lever-state`, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'get_lever_decisions',
    'Read the recent daily lever-tick decision history for the project (newest first; default last 30 days, override with days). Each entry is one UTC day\'s recorded decision: subject draw weights, any variants archived that day, per-variant sample counts, and the channel affinity per coarse-industry bucket. Read-only audit trail — use it to narrate how the no-control levers trended (weight shifts, archive events, channel-affinity moves) without trying to A/B or revert them. Empty until the tick has run at least once.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 30)'),
    },
    async (input, { apiUrl, authHeader }) => {
      const qs = input.days ? `?days=${input.days}` : ''
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(input.projectId)}/lever-decisions${qs}`, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'record_outreach',
    'Record an outreach log entry. status="sent" flips the prospect to "contacted". status="failed" REQUIRES errorMessage and stamps next_outreach_after = sentAt + noResponseRecycleDays (project setting, default 90) so the prospect drops out of get_outbound_targets for that window — covers both intentional skips (errorMessage starting with "skipped: …") and real send errors. status="pending_review" leaves the prospect unchanged but excludes it from get_outbound_targets while the draft is open. errorMessage is rejected with 400 on "sent" / "pending_review". For form / SNS DM where you intend to submit, prefer record_outreach_with_inquiry — it allocates the row pre-submit and returns finalBody with the inquiry-landing URL footer baked in.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin']),
      subject: z.string().optional(),
      body: z.string(),
      variantId: variantIdSchema.optional().describe('Subject variant id from pick_subject_variant. Stamps outreach_logs.variant_id so per-variant reply rates are not biased to email-only sends.'),
      status: z.enum(['sent', 'failed', 'pending_review']).default('sent')
        .describe('"sent" = delivered. "failed" = send error (errorMessage required). "pending_review" = draft created (outbound_mode = draft).'),
      errorMessage: z.string().min(1).max(2000).optional()
        .describe('Required when status="failed"; rejected when status="sent" or "pending_review".'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/outreach', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number }
      return { content: [{ type: 'text' as const, text: `Outreach logged (id: ${result.id}).` }] }
    },
  )

  defineTool(
    'skip_prospect',
    'Record a deliberate decision NOT to contact a prospect on this outbound run — no send is attempted. Use only for the LLM judgment calls the server cannot make: reason="bad_timing" (the prospect overview flags now as a bad moment — layoffs, wind-down, post-acquisition freeze) or reason="no_fresh_material" (a re-approach with nothing new to say). Writes a "skipped" audit row and stamps next_outreach_after = sentAt + noResponseRecycleDays so the prospect drops out of get_outbound_targets for that window (longer existing windows preserved via GREATEST). No quota is consumed and the prospect is NOT marked contacted. Do NOT use this for unsupported-country prospects — get_outbound_targets already filters those server-side.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin'])
        .describe('The channel the run was about to use. Recorded on the audit row only; no send happens.'),
      reason: z.enum(['bad_timing', 'no_fresh_material', 'other'])
        .describe('Structured skip reason. "bad_timing" / "no_fresh_material" are the common cases; "other" is an escape hatch.'),
      note: z.string().min(1).max(2000).optional()
        .describe('Optional one-line context shown in the recent-outreach feed.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/outreach/skip', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number }
      return { content: [{ type: 'text' as const, text: `Prospect skipped (${input.reason}; audit id: ${result.id}).` }] }
    },
  )

  defineTool(
    'get_gmail_status',
    'Check whether the current user has connected their Google account (gmail.send scope) via the LeadAce web app. Returns the connected Gmail address or an indication that Gmail is not connected.',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/auth/google-credentials/status', null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { connected: boolean; email?: string; grantedAt?: string; updatedAt?: string }
      const text = result.connected
        ? `Gmail connected as ${result.email} (granted: ${result.grantedAt}, last refreshed: ${result.updatedAt}).`
        : 'Gmail not connected. Have the user sign in at https://app.leadace.ai (Settings → Connect Google).'
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  defineTool(
    'send_email',
    'Send an email via the user\'s connected Gmail account WITHOUT recording an outreach log. Use for internal notifications (e.g. daily-cycle start/wrap-up emails). For prospect outreach use send_email_and_record instead.',
    {
      to: z.array(z.email()).min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.array(z.email()).optional(),
      bcc: z.array(z.email()).optional(),
      inReplyTo: z
        .string()
        .regex(/^<[^\r\n<>]+>$/, 'inReplyTo must be a single RFC 5322 Message-ID like <id@host>')
        .max(998)
        .optional(),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/auth/send-email', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { messageId: string; threadId: string }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Email sent (Gmail messageId: ${result.messageId}, threadId: ${result.threadId}).`,
          },
        ],
      }
    },
  )

  defineTool(
    'send_email_and_record',
    'Compose and submit a prospect email + outreach log in one call. The server reads the project\'s outboundMode setting and either sends the email (mode "send") or stores a pending_review draft for the user to send from the LeadAce web app (mode "draft"). The send happens server-side whether the project\'s mailbox is a connected Gmail or a custom SMTP mailbox — call this regardless of mode / which mailbox the project uses, and do not branch on outboundMode or sending-identity type in skill logic. The send is complete when this returns.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      to: z.array(z.email()).min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.array(z.email()).optional(),
      bcc: z.array(z.email()).optional(),
      inReplyTo: z.string().optional().describe('Gmail Message-Id header for threading'),
      variantId: variantIdSchema.optional().describe('Subject variant id from pick_subject_variant. Stamps outreach_logs.variant_id so /evaluate can join reply rates per variant.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'POST',
        '/outreach/send-and-record',
        input,
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as
        | { mode: 'sent'; outreachId: number; messageId: string; threadId: string }
        | { mode: 'drafted'; outreachId: number }
      const text = result.mode === 'sent'
        ? `Email sent. Outreach logged (id: ${result.outreachId}).`
        : `Draft created (outreach id: ${result.outreachId}). User reviews and sends from https://app.leadace.ai/drafts.`
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  defineTool(
    'discard_drafts',
    'Batch-delete pending_review drafts. Pass either ids (explicit list, max 200) for selective cleanup, or projectId to wipe every pending_review draft in that project. Already-sent / failed rows are silently excluded. Returns deletedIds + skippedIds (the latter only meaningful in id-list mode — ids that did not match a pending_review row in this tenant). Preview targets first with list_drafts.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(200).optional()
        .describe('Explicit list of outreach log ids to discard. Mutually exclusive with projectId.'),
      projectId: z.string().min(1).optional()
        .describe('Project name or ID. When set (and ids omitted), wipes every pending_review draft in that project. Mutually exclusive with ids.'),
    },
    async ({ ids, projectId }, { apiUrl, authHeader }) => {
      if ((ids && projectId) || (!ids && !projectId)) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: pass exactly one of ids or projectId.',
          }],
          isError: true,
        }
      }
      const body: { ids: number[] } | { allInProjectId: string } = ids
        ? { ids }
        : { allInProjectId: projectId! }
      const { ok, data } = await callApi('POST', '/outreach/drafts/discard', body, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { deletedIds: number[]; skippedIds: number[] }
      const skippedNote = result.skippedIds.length > 0
        ? ` Skipped (already-sent / not in tenant / not found): ${result.skippedIds.join(', ')}.`
        : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Discarded ${result.deletedIds.length} draft(s).${skippedNote}`,
        }],
      }
    },
  )

  defineTool(
    'list_drafts',
    'List pending_review drafts for a project (newest first, paginated). Returns total and rows with a truncated bodyPreview; full review/edit/send happens at https://app.leadace.ai/drafts. Use to check pending drafts or preview a discard_drafts.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
    },
    async ({ projectId, limit, offset }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/drafts?limit=${limit}&offset=${offset}`,
        null,
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { drafts, total } = data as {
        drafts: Array<{
          id: number
          prospectId: number
          prospectName: string
          prospectEmail: string | null
          channel: string
          subject: string | null
          body: string
          createdAt: string
        }>
        total: number
      }
      const rows = drafts.map((d) => ({
        id: d.id,
        prospectId: d.prospectId,
        prospectName: d.prospectName,
        prospectEmail: d.prospectEmail,
        channel: d.channel,
        subject: d.subject,
        bodyPreview: d.body.length > 200 ? `${d.body.slice(0, 200)}…` : d.body,
        createdAt: d.createdAt,
      }))
      return {
        content: [{
          type: 'text' as const,
          text: `${total} pending_review draft(s); showing ${rows.length} from offset ${offset}.\n${JSON.stringify(rows, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'update_prospect_status',
    'Update the status of a prospect in a project (e.g. mark as inactive, rejected).',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      status: z.enum(prospectStatusEnum.enumValues),
    },
    async ({ projectId, prospectId, status }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'PATCH',
        `/prospects/${prospectId}/status`,
        { projectId, status },
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Status updated to "${status}".` }] }
    },
  )

  defineTool(
    'update_organization',
    'Partial-update an organization\'s name or website URL. Domain is immutable (it is the per-tenant dedup key). Use when /build-list or imports created the org with a stale name (e.g., before a rebrand) and the visible name needs correcting. organizationId is the integer PK from get_organizations / org listings, not a domain.',
    {
      organizationId: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
      }).describe('Fields to update. At least one required.'),
    },
    async ({ organizationId, patch }, { apiUrl, authHeader }) => {
      if (Object.keys(patch).length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: patch is empty (provide name and/or websiteUrl).' }], isError: true }
      }
      const { ok, data } = await callApi('PATCH', `/organizations/${organizationId}`, patch, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const fields = Object.keys(patch).join(', ')
      return { content: [{ type: 'text' as const, text: `Organization ${organizationId} updated. Fields: ${fields}.` }] }
    },
  )

  defineTool(
    'update_prospect',
    'Partial-update a tenant prospect\'s fields (organization-level columns: name / contactName / department / overview / industry / websiteUrl / email / contactFormUrl / formType / snsAccounts / notes / hypothesis / country / countrySource). Only the keys you pass are written; null clears a nullable field. The prospect must keep at least one contact channel (email, contactFormUrl, or any snsAccounts entry) — UNPROCESSABLE if the patch would leave none. CONFLICT when email or contactFormUrl already belongs to another prospect in the workspace. For per-project status use update_prospect_status. matchReason and priority also live on the project_prospects junction but are not patchable here or via update_prospect_status — they are set at registration / linking and rewritten only by re-importing the prospect with import_prospects (dedupPolicy="overwrite"). For DNC use set_prospect_do_not_contact.',
    {
      prospectId: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        contactName: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        overview: z.string().min(1).optional(),
        industry: z.string().nullable().optional(),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        email: z.email().nullable().optional().describe('Set to null to clear; setting both email and contactFormUrl to null requires snsAccounts to be present.'),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional(),
        formType: z.enum(['google_forms', 'native_html', 'wordpress_cf7', 'iframe_embed', 'with_captcha']).nullable().optional(),
        snsAccounts: z.object({
          x: z.string().optional(),
          linkedin: z.string().optional(),
          instagram: z.string().optional(),
          facebook: z.string().optional(),
        }).nullable().optional(),
        notes: z.string().nullable().optional(),
        hypothesis: z.object({
          targetDepartment: z.string().optional(),
          targetRolePattern: z.string().optional(),
          hypothesizedPain: z.array(z.string()).optional(),
          valueMapping: z.array(z.string()).optional(),
          timingSignals: z.array(z.string()).optional(),
          bestChannel: z.string().optional(),
          bestKeyperson: z.string().optional(),
        }).nullable().optional(),
        country: z.string().regex(/^[A-Z]{2}$/, 'must be ISO 3166-1 alpha-2').nullable().optional(),
        countrySource: z.enum(['manual', 'ai_inferred']).nullable().optional(),
      }).describe('Fields to update. Omit a key to leave it unchanged; pass null to clear (only on nullable columns).'),
    },
    async ({ prospectId, patch }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('PATCH', `/prospects/${prospectId}`, patch, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const fields = Object.keys(patch).join(', ') || '(none)'
      return { content: [{ type: 'text' as const, text: `Prospect ${prospectId} updated. Fields: ${fields}.` }] }
    },
  )

  defineTool(
    'set_prospect_do_not_contact',
    'Toggle the do_not_contact flag on a tenant prospect. Use after /import-prospects when the source had no DNC column but you know certain rows are unsubscribed/opted-out, or for ad-hoc DNC management outside the response-recording flow. DNC prospects are excluded from /build-list re-discovery and from outbound targeting.',
    {
      prospectId: z.number().int(),
      doNotContact: z.boolean().describe('true to mark do-not-contact; false to clear the flag.'),
    },
    async ({ prospectId, doNotContact }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'PATCH',
        `/prospects/${prospectId}/do-not-contact`,
        { doNotContact },
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Prospect ${prospectId}: do_not_contact = ${doNotContact}.` }] }
    },
  )

  defineTool(
    'get_recent_outreach',
    'Get recent outreach logs for a project. Confirmed events only (sent / failed / skipped) — pending_review drafts and pre_send rows are excluded; use list_drafts for drafts. Used by check-responses to match Gmail/SNS replies to sent messages. Each log carries the recipient identifiers (prospectName, contactName, prospectEmail, organizationDomain) so the skill can match by domain and name leads in the report without a second lookup. Each log also carries inquiry-landing aggregates: inquirySessionCount, inquiryOutcome (opened / inquired / unsubscribed / signup_clicked / lead / null — most-significant outcome ever recorded; signup_clicked is the self-serve counterpart to lead, surfaced only when the project runs in inquiryCtaType="signup"), inquiryMeetingSource (button / chat / null — only set when inquiryOutcome === "lead"), inquiryLastVisitAt — surface lead-via-landing and signup-via-landing alongside email replies, and skip reply-draft creation for outreach where the recipient already became a lead or signup via the inquiry page.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      limit: z.number().int().min(1).max(200).default(100),
    },
    async ({ projectId, limit }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/outreach/recent?limit=${limit}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { logs } = data as { logs: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: `${logs.length} recent outreach logs.\n${JSON.stringify(logs, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'record_response',
    'Record a response (email reply, SNS DM, etc.) to an outreach. Updates prospect status and optionally marks do-not-contact. For rejections, pass rejectionFeedback to capture the structured reason — feature_gap notes are tracked as PMF signal; unsubscribe_request / preferred_recontact_window=never / consent.* opt-outs auto-flip do_not_contact; primary_reason wrong_timing/budget + preferred_recontact_window 3/6/12_months auto-defers (sets status="deferred" and prospects.next_outreach_after) so the prospect re-enters the outbound queue when the window passes; decision_maker_pointer with email auto-creates a new prospect (linked to every project the referring prospect is in, status="new", priority preserved) inheriting org/overview/websiteUrl/industry — pointer.name only without email updates an existing same-org contact role/department instead, returned as derivedProspects.',
    {
      outreachLogId: z.number().int().describe('ID of the outreach log this response is for'),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin']),
      content: z.string().describe('Response content'),
      sentiment: z.enum(['positive', 'neutral', 'negative']),
      responseType: z.enum(['reply', 'auto_reply', 'bounce', 'meeting_request', 'rejection']),
      receivedAt: z.string().datetime().optional(),
      markDoNotContact: z.boolean().default(false).describe('Set true for bounces or unsubscribes'),
      rejectionFeedback: z.object({
        version: z.literal(1),
        primary_reason: z.enum(REJECTION_PRIMARY_REASONS),
        secondary_reasons: z.array(z.enum(REJECTION_PRIMARY_REASONS)).max(5).optional(),
        free_text: z.string().max(500).optional(),
        decision_maker_pointer: z.object({
          name: z.string().max(200).optional(),
          email: z.email().max(320).optional(),
          role: z.string().max(200).optional(),
        }).optional(),
        preferred_recontact_window: z.enum(REJECTION_RECONTACT_WINDOWS).optional(),
        consent: z.object({
          gdpr_erasure_request: z.boolean().optional(),
          ccpa_opt_out: z.boolean().optional(),
          marketing_opt_out: z.boolean().optional(),
        }).optional(),
        submitted_at: z.string().datetime(),
        tenant_signature: z.string().optional(),
      }).optional().describe('Only valid when responseType="rejection". Schema: https://leadace.ai/schema/rejection-feedback-v1.json'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/responses', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number; derivedProspects?: { id: number; name: string; action: 'created' | 'matched_existing' }[] }
      const derived = result.derivedProspects ?? []
      const derivedNote = derived.length === 0
        ? ''
        : ' Derived prospects: ' + derived.map((p) => `${p.name} (id ${p.id}, ${p.action})`).join(', ') + '.'
      return { content: [{ type: 'text' as const, text: `Response recorded (id: ${result.id}).${derivedNote}` }] }
    },
  )

  defineTool(
    'get_rejection_feedback_summary',
    'Aggregate rejection_feedback. With scope="pmf" returns the PMF slice (feature_gap, already_have_solution, competitor_locked) — primary_reason distribution + feature_gap free-text notes, with total and percentages computed within the PMF subset. Used by /check-feedback. With scope="tactical" returns the non-PMF slice — primary_reason distribution + recontactWindows (per-bucket count + samples for every RejectionRecontactWindow value: "never", "3_months", "6_months", "12_months", "unspecified" — empty buckets carry {count:0,samples:[]}) + decision_maker_pointer + not_relevant notes (with industry context). Used by /evaluate to drive targeting; recontact-window prospects are auto-deferred and decision_maker_pointer rows auto-create or update prospects at record_response time, both surface here as a transparency log only. scope="all" (default) returns the unfiltered union.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      windowDays: z.number().int().min(1).max(3650).optional().describe('Restrict to rejections received within the last N days. Omit for all-time.'),
      scope: z.enum(['pmf', 'tactical', 'all']).optional().describe('"pmf" → PMF slice only; "tactical" → non-PMF slice only; "all" (default) → unfiltered union.'),
    },
    async ({ projectId, windowDays, scope }, { apiUrl, authHeader }) => {
      const params = new URLSearchParams()
      if (windowDays != null) params.set('windowDays', String(windowDays))
      if (scope != null) params.set('scope', scope)
      const qs = params.toString() ? `?${params.toString()}` : ''
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/rejection-feedback/summary${qs}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'get_eval_data',
    'Get evaluation statistics for a project: response rates, channel performance, sentiment breakdown, and inquiry-landing outcome counts (opened / inquired / lead / signup_clicked / unsubscribed). Also returns responded message bodies and a data sufficiency check.',
    { projectId: z.string().min(1).describe('Project name or ID') },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/stats`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      }
    },
  )

  defineTool(
    'record_evaluation',
    'Apply an evaluation\'s conclusions by bulk-overriding prospect priorities by industry (only status=new prospects are affected). Returns per-industry rowsAffected. The analysis itself is reported to the user and distilled into the learnings document, not stored.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      priorityUpdates: z.array(z.object({
        industry: z.string().min(1),
        priority: prioritySchema,
      })).min(1).max(50).describe('Bulk priority updates by industry (required, non-empty, max 50, one row per industry — duplicates are rejected by the API).'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/evaluations', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { priorityUpdates: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: `Priority updates applied: ${JSON.stringify(result.priorityUpdates)}`,
        }],
      }
    },
  )

  defineTool(
    'get_document',
    'Get the latest version of a project document (business, sales_strategy, search_notes, email_template, learnings).',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      slug: z.string().describe('Document slug: "business", "sales_strategy", "search_notes", "email_template", or "learnings"'),
    },
    async ({ projectId, slug }, { apiUrl, authHeader }) => {
      const { ok, status, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/documents/${slug}`, null, apiUrl, authHeader)
      if (!ok) {
        if (status === 404) {
          return { content: [{ type: 'text' as const, text: `Document "${slug}" not found for project "${projectId}".` }] }
        }
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const doc = data as { id: number; slug: string; content: string; createdAt: string }
      return {
        content: [{ type: 'text' as const, text: doc.content }],
      }
    },
  )

  defineTool(
    'save_document',
    'Save a new version of a project document. Appends a new version (immutable); previous versions are preserved. Use slug "email_template" to set the project-specific outreach email body template (the default base is master doc tpl_email_base); slug "learnings" is the cross-stage Learnings Log /evaluate maintains.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      slug: z.string().describe('Document slug: "business", "sales_strategy", "search_notes", "email_template", or "learnings"'),
      content: z.string().describe('Full markdown content of the document'),
    },
    async ({ projectId, slug, content }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('PUT', `/projects/${encodeURIComponent(projectId)}/documents/${slug}`, { content }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number; slug: string; createdAt: string }
      return { content: [{ type: 'text' as const, text: `Document "${slug}" saved (version id: ${result.id}).` }] }
    },
  )

  defineTool(
    'list_documents',
    'List all documents for a project with their last updated timestamps.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/documents`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { documents } = data as { documents: Array<{ slug: string; updatedAt: string }> }
      if (documents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No documents found.' }] }
      }
      return {
        content: [{
          type: 'text' as const,
          text: `${documents.length} document(s).\n${JSON.stringify(documents, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'get_master_document',
    'Get a master document (shared templates, guidelines, frameworks) by slug.',
    {
      slug: z.string().describe('Master document slug (e.g. "tpl_business", "tpl_email_guidelines")'),
    },
    async ({ slug }, { apiUrl, authHeader }) => {
      const { ok, status, data } = await callApi('GET', `/master-documents/${slug}`, null, apiUrl, authHeader)
      if (!ok) {
        if (status === 404) {
          return { content: [{ type: 'text' as const, text: `Master document "${slug}" not found.` }] }
        }
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const doc = data as { id: number; slug: string; content: string; version: number; updatedAt: string }
      return {
        content: [{ type: 'text' as const, text: doc.content }],
      }
    },
  )

  defineTool(
    'list_master_documents',
    'List all available master documents (templates, guidelines, frameworks).',
    {},
    async (_args, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', '/master-documents', null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { documents } = data as { documents: Array<{ slug: string; version: number; updatedAt: string }> }
      if (documents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No master documents found.' }] }
      }
      return {
        content: [{
          type: 'text' as const,
          text: `${documents.length} master document(s).\n${JSON.stringify(documents, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'list_tenant_prospects',
    'List existing prospects across the entire tenant (every project the user owns). Use this in /match-prospects to find prospects gathered for past projects that may fit the current project. Excludes do-not-contact prospects. excludeProjectId omits prospects already linked to that project. q is a substring match on name / overview / industry / organization name. Returns up to 1000 rows.',
    {
      excludeProjectId: z.string().min(1).optional()
        .describe('Project name or ID — omit prospects already linked to this project'),
      q: z.string().optional().describe('Substring search on name / overview / industry / org name'),
      industry: z.string().optional().describe('Exact-match industry filter'),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    async ({ excludeProjectId, q, industry, limit }, { apiUrl, authHeader }) => {
      const params = new URLSearchParams()
      if (excludeProjectId) params.set('excludeProjectId', excludeProjectId)
      if (q) params.set('q', q)
      if (industry) params.set('industry', industry)
      params.set('limit', String(limit))

      const { ok, data } = await callApi('GET', `/tenant/prospects?${params.toString()}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { prospects: unknown[]; total: number }
      return {
        content: [{
          type: 'text' as const,
          text: `${result.total} tenant prospect(s).\n${JSON.stringify(result.prospects, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'link_existing_prospects_to_project',
    'Link existing tenant prospects to a project by creating project_prospects junction rows. Does NOT create new prospects or organizations — pair with list_tenant_prospects to discover candidates first. Skips prospects flagged do_not_contact and reports prospects already linked. Use this in /match-prospects after the LLM picks targets and the user approves.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      links: z.array(z.object({
        prospectId: z.number().int(),
        matchReason: z.string().min(1).describe('Why this prospect fits the current project'),
        priority: prioritySchema.default(3),
      })).min(1).max(200),
    },
    async ({ projectId, links }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/prospects/link`,
        { links },
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as {
        linked: number
        alreadyLinked: number
        skipped: number
        skippedDetails: unknown[]
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Linked: ${result.linked} new, ${result.alreadyLinked} already linked, ${result.skipped} skipped.\nSkipped: ${JSON.stringify(result.skippedDetails)}`,
        }],
      }
    },
  )

  defineTool(
    'get_project_settings',
    'Get user-editable project settings (outboundMode, senderEmailAlias, senderDisplayName, senderCompanyName, senderJobTitle, unsubscribeEnabled, outboundChannels, targetCountries, ...). Returns defaults if no row exists yet. Skills should call this before strategy/build-list/outbound/daily-cycle to honor user-controlled behavior — especially outboundChannels (skip prospects whose only channel is disabled) and targetCountries (narrow discovery / exclude prospects outside the allowlist when non-empty).',
    { projectId: z.string().min(1).describe('Project name or ID') },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/settings`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'update_project_settings',
    'Update user-editable project settings. Any omitted field keeps its current value. Pass null to clear nullable fields.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      outboundMode: z.enum(OUTBOUND_MODES).optional()
        .describe('"send" = send immediately. "draft" = store as LeadAce drafts for review (user sends from app.leadace.ai/drafts).'),
      senderEmailAlias: z.email().nullable().optional()
        .describe('Gmail Send-As alias to use as From: address. null = primary Gmail.'),
      senderDisplayName: z.string().min(1).max(200).nullable().optional()
        .describe('Personal name shown as the email From: display name and as "From {senderDisplayName}" on the inquiry landing header.'),
      senderCompanyName: z.string().min(1).max(200).nullable().optional()
        .describe('Company / brand name shown to recipients on the inquiry landing as "From {senderDisplayName} at {senderCompanyName}". Distinct from tenants.legalName (compliance footer) and tenants.name (internal workspace label). null omits the suffix.'),
      senderJobTitle: z.string().min(1).max(200).nullable().optional()
        .describe('Optional job title / role shown alongside senderDisplayName on the inquiry landing header as "From {senderDisplayName}, {senderJobTitle} at {senderCompanyName}". No-op when senderDisplayName is null.'),
      unsubscribeEnabled: z.boolean().optional()
        .describe('Currently no-op (always-on for compliance) — toggle reserved for v1.x. Updates persist but do not gate the unsubscribe link / List-Unsubscribe header.'),
      inquiryLandingEnabled: z.boolean().optional()
        .describe('When true, outbound emails include an inquiry-landing URL footer that hosts a per-recipient AI chat, meeting-request button, and unsubscribe-with-reason flow.'),
      inquiryChatBrief: z.string().max(4000).nullable().optional()
        .describe('Briefing for the inquiry-landing chat agent (offer summary, talking points, what to defer to a human). null disables chat input but keeps the rest of the landing page rendering.'),
      inquiryOneLiner: z.string().max(140).nullable().optional()
        .describe('Single-sentence value prop shown above the chat input on the landing page.'),
      inquiryVideoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('YouTube/Vimeo unlisted video URL embedded on the landing page. https:// only.'),
      inquiryPdfUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('Public URL for the "download PDF" button on the landing page. https:// only.'),
      inquiryBrandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional()
        .describe('6-digit hex color (e.g. "#1f6feb") for the landing page accent.'),
      inquiryBrandLogoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('Public URL for the brand logo shown on the landing page. https:// only.'),
      inquiryDarkBackground: z.boolean().optional()
        .describe('Landing background mode. false = light canvas (default), true = dark. The brand color stays the accent on either.'),
      inquiryCtaType: z.enum(['meeting', 'signup']).optional()
        .describe('Landing CTA mode. "meeting" (default) renders Book/Request meeting (human-sales path; inquiryCtaUrl is then an optional scheduling URL). "signup" renders a Sign up button that redirects visitors to inquiryCtaUrl (self-serve path, no human follow-up); inquiryCtaUrl is required in this mode. The two are mutually exclusive — one CTA per project.'),
      inquiryCtaUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('CTA URL. For inquiryCtaType="meeting" this is an optional scheduling URL (Calendly, TimeRex, etc.) — when set, the meeting button opens it in a new tab; when null, the button is notify-only. For inquiryCtaType="signup" this is the SaaS signup page URL and is required. https:// only.'),
      maxReapproachCycles: z.coerce.number().int().min(1).max(10).optional()
        .describe('Hard cap on rejection cycles before forcing rejected + DNC. Default 3.'),
      unspecifiedRecontactWindowMonths: z.coerce.number().int().min(1).max(24).optional()
        .describe('Months to defer when rejection feedback preferred_recontact_window is "unspecified". Default 3.'),
      noResponseRecycleDays: z.coerce.number().int().min(7).max(365).optional()
        .describe('Days after a sent outreach to make the prospect re-eligible if no response arrived. Default 90. Stamped via GREATEST(existing, sentAt + days) — only advances the window forward, never shortens an explicit longer window (e.g. a rejection-feedback 12_months deferral).'),
      followUpSequence: z.object({
        enabled: z.boolean().optional(),
        gapDays: z.array(z.coerce.number().int().min(1).max(90)).min(1).max(5).optional(),
      }).optional()
        .describe('Day-scale follow-up sequence for unanswered prospects (P1). gapDays = relative waits in DAYS before each next touch; default [3,7,7] yields touches at day 0 / 3 / 10 / 17 (max touches = gapDays.length + 1). Distinct from the months-scale noResponseRecycleDays (90-day recycle) and rejection re-approach windows. enabled defaults true for projects created after this shipped, false for older projects; setting enabled:false also clears any in-progress sequences. Whole-object replace — send the full override set you want, not a partial merge.'),
      outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).optional()
        .describe('Channels the project is allowed to use for outbound. Subset of {email, form, sns_twitter, sns_linkedin}. Default is all four. Narrow this when the operator wants to avoid less-stable browser-driven channels — skills must skip prospects whose only reachable channel is disabled. An empty array effectively pauses the project for outbound.'),
      targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).optional()
        .describe('ISO 3166-1 alpha-2 codes that further narrow the compliance-level send allowlist (currently US / CA / JP). Empty array (default) = no project-level restriction. Non-empty = explicit allowlist; /build-list focuses discovery on these countries and /outbound excludes prospects outside the set in addition to the unchanged send-time compliance gate.'),
    },
    async ({ projectId, ...patch }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('PUT', `/projects/${encodeURIComponent(projectId)}/settings`, patch, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  return tools
}

// Built lazily on the first MCP request per isolate, then memoized. Requests
// that never touch the catalog (OAuth flow, /.well-known/*) don't pay the
// build cost on a cold isolate.
let toolRegistry: ToolDef[] | null = null

function createMcpServer(ctx: ToolCtx): McpServer {
  toolRegistry ??= buildToolRegistry()
  const server = new McpServer({ name: 'lead-ace', version: SERVER_VERSION })
  for (const tool of toolRegistry) {
    server.tool(tool.name, tool.description, tool.schema, (args) => tool.handler(args, ctx))
  }
  return server
}

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      console.error('Unhandled error:', e)
      // No-op when SENTRY_DSN is unset (self-host / local). The full exception
      // (incl. message) goes to Sentry, so the response stays opaque — no
      // internal detail to unauthenticated callers (matches the API worker).
      Sentry.captureException(e)
      return withCors(Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      ))
    }
  },
}

export default Sentry.withSentry(
  (env: Env) => sentryOptions(env.SENTRY_DSN, env.ENVIRONMENT),
  mcpHandler,
)

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const baseUrl = url.origin

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (path === '/.well-known/oauth-authorization-server') {
    return withCors(handleMetadata(baseUrl))
  }

  if (path === '/.well-known/oauth-protected-resource') {
    return withCors(handleResourceMetadata(baseUrl))
  }

  if (path === '/register' && request.method === 'POST') {
    return withCors(await handleRegister(request, env.MCP_OAUTH_STORE))
  }

  if (path === '/authorize' && request.method === 'GET') {
    return await handleAuthorizeGet(request, env.MCP_OAUTH_STORE, env.FRONTEND_URL)
  }

  if (path === '/authorize/session' && request.method === 'GET') {
    return withCors(await handleAuthorizeSessionInfo(request, env.MCP_OAUTH_STORE))
  }

  if (path === '/authorize/finalize' && request.method === 'POST') {
    return withCors(
      await handleAuthorizeFinalize(request, env.MCP_OAUTH_STORE, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL),
    )
  }

  if (path === '/token' && request.method === 'POST') {
    return withCors(await handleToken(request, env.MCP_OAUTH_STORE, env.SUPABASE_JWT_SECRET))
  }

  // RFC 7009 token revocation. The presented token is the authentication —
  // no Bearer header required.
  if (path === '/revoke' && request.method === 'POST') {
    return withCors(await handleRevoke(request, env.MCP_OAUTH_STORE))
  }

  const authHeaderRaw = request.headers.get('Authorization')
  const userId = await extractUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
  if (!userId) {
    const hasBearer = authHeaderRaw?.startsWith('Bearer ') ?? false
    let accessFp: string | null = null
    let exp: number | null = null
    let nowGap: number | null = null
    if (hasBearer) {
      const token = authHeaderRaw!.slice(7)
      accessFp = await fingerprint(token)
      // Best-effort decode of exp claim without verification (verification already failed above).
      try {
        const parts = token.split('.')
        if (parts.length === 3 && parts[1]) {
          const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
          const claims = JSON.parse(payloadJson) as { exp?: number }
          if (typeof claims.exp === 'number') {
            exp = claims.exp
            nowGap = Math.floor(Date.now() / 1000) - claims.exp
          }
        }
      } catch {
        // best-effort diagnostics only
      }
    }
    console.log('[mcp.auth] 401', { path, method: request.method, hasBearer, accessFp, exp, nowGap })
    return withCors(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    }))
  }

  // Session-management endpoints are Supabase-session-only — extractSupabaseUserId
  // rejects MCP-minted tokens (aud=mcp) so an authorized MCP client cannot
  // revoke its siblings or enumerate other sessions for the user it acts
  // on behalf of.
  if (path === '/sessions' && request.method === 'GET') {
    const supabaseUserId = await extractSupabaseUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
    if (!supabaseUserId) {
      return withCors(Response.json({ error: 'forbidden' }, { status: 403 }))
    }
    return withCors(await handleListSessions(supabaseUserId, env.MCP_OAUTH_STORE))
  }
  const sessionRevokeMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (sessionRevokeMatch && request.method === 'DELETE') {
    const supabaseUserId = await extractSupabaseUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
    if (!supabaseUserId) {
      return withCors(Response.json({ error: 'forbidden' }, { status: 403 }))
    }
    return withCors(await handleRevokeSession(supabaseUserId, sessionRevokeMatch[1]!, env.MCP_OAUTH_STORE))
  }

  // Stateless mode does not support SSE streams, and Workers cannot keep
  // long-lived connections — POST only.
  if (request.method !== 'POST') {
    return withCors(Response.json(
      { error: 'Method not allowed. Use POST for MCP requests.' },
      { status: 405 },
    ))
  }

  const authHeader = request.headers.get('Authorization') ?? ''
  const server = createMcpServer({ apiUrl: env.WEB_API_URL, authHeader })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true, // Return JSON instead of SSE streams (Workers compat)
  })

  await server.connect(transport)
  return withCors(await transport.handleRequest(request))
}
