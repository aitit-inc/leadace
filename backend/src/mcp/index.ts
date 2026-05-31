import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { verifyJwt, verifySupabaseJwt } from '../auth/verify-jwt'
import { BUG_REPORT_CATEGORIES, OUTBOUND_MODES, OUTBOUND_CHANNELS, REJECTION_PRIMARY_REASONS, REJECTION_RECONTACT_WINDOWS, prospectStatusEnum, prioritySchema } from '../db/schema'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'
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
}

// SERVER_VERSION is informational — the deployed backend's own version.
// MIN_PLUGIN_VERSION is the gate: any plugin older than this MUST be told to
// run `/plugin update leadace@leadace` because backend behavior assumes the
// new plugin contract. Bump this **only when** introducing a backend change
// that the old plugin cannot tolerate (removed tool, renamed required arg,
// changed response shape). See .claude/rules/release.md.
const SERVER_VERSION = '1.0.0'
// 0.5.107 hard-cuts < 0.5.107 plugins because get_rejection_feedback_summary's
// `recontactWindows` response shape changed from Array<{window, ...}> to
// Record<RejectionRecontactWindow, {count, samples}>. Older plugin SKILL.md
// (`/evaluate`, `/check-feedback`) instructs the LLM to "list recontactWindows
// rows", which no longer matches the JSON.
const MIN_PLUGIN_VERSION = '0.5.107'

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

async function resolveProjectId(
  projectRef: string,
  apiUrl: string,
  authHeader: string,
): Promise<{ id: string | null; error?: string }> {
  const { ok, data } = await callApi('GET', '/projects', null, apiUrl, authHeader)
  if (!ok) {
    const err = data as { error?: string }
    return { id: null, error: err.error ?? 'Failed to list projects' }
  }
  const { projects } = data as { projects: Array<{ id: string; name: string }> }
  const match = projects.find((p) => p.id === projectRef || p.name === projectRef)
  if (!match) {
    return { id: null, error: `Project "${projectRef}" not found` }
  }
  return { id: match.id }
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

function createMcpServer(apiUrl: string, authHeader: string): McpServer {
  const server = new McpServer({ name: 'lead-ace', version: SERVER_VERSION })

  server.tool(
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

  server.tool(
    'report_bug',
    'File a bug, feedback, or idea about LeadAce. The maintainer reviews these out of band on the LeadAce backend (no public issue is opened). Use freely from any skill — include what you tried, what happened, and what you expected. The optional `context` field accepts arbitrary JSON metadata (skill name, plugin version, prospect/project ids, etc.). Daily-capped per tenant; on cap exhaustion the call returns an error and the user can retry tomorrow. self-host installs collect reports in their own database (the maintainer does not see them).',
    {
      category: z.enum(BUG_REPORT_CATEGORIES)
        .describe('"bug" = something is broken / wrong. "feedback" = working but rough / confusing. "idea" = a feature request or product suggestion.'),
      title: z.string().min(3).max(200)
        .describe('One-line summary, e.g. "/check-results crashes when no Gmail connected".'),
      body: z.string().min(10).max(4000)
        .describe('What you tried, what happened, what you expected. Include reproduction steps if you have them.'),
      context: z.record(z.string(), z.unknown()).optional()
        .describe('Optional structured metadata (any JSON object). Suggested keys: skill, pluginVersion, projectId, prospectId, errorMessage.'),
    },
    async (input) => {
      const { ok, data } = await callApi('POST', '/bug-reports', input, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { id: number }
      return { content: [{ type: 'text' as const, text: `Reported (id: ${result.id}). Thanks — the maintainer will review it.` }] }
    },
  )

  server.tool(
    'list_projects',
    'List all projects for the current user.',
    {},
    async () => {
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

  server.tool(
    'setup_project',
    'Create a new LeadAce project. Returns the auto-generated project ID. Returns an error if the plan limit is reached.',
    { name: z.string().describe('Project name (unique per tenant)') },
    async ({ name }) => {
      const { ok, data } = await callApi('POST', '/projects', { name }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}${err.detail ? ` — ${err.detail}` : ''}` }], isError: true }
      }
      const result = data as { id: string; name: string }
      return { content: [{ type: 'text' as const, text: `Project "${name}" created (id: ${result.id}).` }] }
    },
  )

  server.tool(
    'delete_project',
    'Delete a project and all its data (prospects, outreach logs, responses, evaluations).',
    { projectId: z.string().describe('Project name or ID') },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('DELETE', `/projects/${resolved.id}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Project "${projectId}" deleted.` }] }
    },
  )

  server.tool(
    'add_prospects',
    'Batch register prospects. Server-side dedup is the single source of truth for duplicate avoidance. Each skipped row comes back in skippedDetails as {name, reason} where reason ∈ "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch" | "plan_limit". Use those codes to adjust your search keywords (e.g. lots of "email_duplicate" → narrow the search; lots of "already_in_project" → cluster is exhausted). projectId is optional: omit it to save prospects as tenant-only assets (no project link). When projectId is provided, every prospect must include matchReason. Set doNotContact=true on rows the source data marks as unsubscribed/opted-out so /build-list will not re-contact them later (DNC is a one-way ratchet on overwrite — false never clears an existing flag). Pair tenant-only imports with /match-prospects to link the right ones into a project later.',
    {
      projectId: z.string().optional().describe('Project name or ID. Omit to save prospects as tenant-only assets without linking to any project.'),
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
    async ({ projectId, prospects }) => {
      let resolvedId: string | undefined
      if (projectId) {
        const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
        if (!resolved.id) {
          return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
        }
        resolvedId = resolved.id
      }
      const { ok, data } = await callApi('POST', '/prospects/batch', { projectId: resolvedId, prospects }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { inserted: number; skipped: number; insertedIds: number[]; skippedDetails: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: `Registered (${formatTarget(resolvedId)}): ${result.inserted}, Skipped: ${result.skipped}\nSkipped details: ${JSON.stringify(result.skippedDetails)}`,
        }],
      }
    },
  )

  server.tool(
    'check_prospect_dedup',
    'Read-only pre-flight duplicate check. Use after candidate discovery, before paying for heavy contact retrieval: pass each candidate\'s organizationDomain (and email / contactFormUrl if surfaced incidentally), receive {kind: "fresh" | "skip", reason?} per candidate in input order. Skip reasons are the dedup-only subset of add_prospects: "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch". add_prospects also emits "plan_limit" — that is a budget signal, never emitted here. Drop kind="skip" candidates before launching contact-retrieval sub-agents; add_prospects re-runs the same dedup as a safety net. Up to 100 candidates per call.',
    {
      projectId: z.string().optional().describe('Project name or ID. Omit for tenant-scope dedup only (no project-link check).'),
      candidates: z.array(z.object({
        organizationDomain: z.string().describe('Organization domain. Apex form preferred (e.g. example.com); raw URLs and "www." prefix are tolerated and normalized server-side. Required.'),
        email: z.email().optional(),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
      })).describe('Array of candidates to check (max 100)'),
    },
    async ({ projectId, candidates }) => {
      let resolvedId: string | undefined
      if (projectId) {
        const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
        if (!resolved.id) {
          return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
        }
        resolvedId = resolved.id
      }
      const { ok, data } = await callApi('POST', '/prospects/check-dedup', { projectId: resolvedId, candidates }, apiUrl, authHeader)
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
          text: `Checked ${result.decisions.length} (${formatTarget(resolvedId)}): ${fresh} fresh, ${skip} skip.\nDecisions: ${JSON.stringify(result.decisions)}`,
        }],
      }
    },
  )

  server.tool(
    'import_prospects_from_csv',
    'Import prospects from a canonical CSV string. Required headers: organizationDomain, organizationName, organizationWebsiteUrl, name, overview, websiteUrl. matchReason is required only when projectId is provided. Optional headers: contactName, department, industry, email, contactFormUrl, formType, snsAccounts.x, snsAccounts.linkedin, snsAccounts.instagram, snsAccounts.facebook, notes, priority, doNotContact. At least one of email / contactFormUrl / snsAccounts.* per row. doNotContact accepts 1/true/yes/on (DNC) or 0/false/no/off (not DNC); empty cells are treated as not provided. Set it on rows the source marks as unsubscribed/opted-out so /build-list will not re-discover and contact them. On overwrite, doNotContact=true sets the flag on existing prospects; false (or column absent) never clears an existing flag (one-way ratchet). projectId is optional: omit it to save prospects as tenant-only assets (no project_prospects link is created — pair with /match-prospects to link them into a project later). dedupPolicy "skip" leaves existing prospects alone; "overwrite" updates prospect fields (matched by email or contactFormUrl) and re-links to the project. Rows that match only by organization domain are skipped as "already_in_project" even with "overwrite" — the prospect identity within that organization is ambiguous and cannot be safely updated. Existing prospects already flagged do_not_contact are always skipped (their record is preserved). Skipped rows are returned in skippedDetails as {row, name, reason} where reason ∈ "email_duplicate" | "form_url_duplicate" | "already_in_project" | "do_not_contact" | "duplicate_in_batch" | "plan_limit". Max 1000 data rows.',
    {
      projectId: z.string().optional().describe('Project name or ID. Omit to save prospects as tenant-only assets without linking to any project.'),
      csvText: z.string().describe('Full CSV text including header row'),
      dedupPolicy: z.enum(['skip', 'overwrite']).default('skip'),
    },
    async ({ projectId, csvText, dedupPolicy }) => {
      let resolvedId: string | undefined
      if (projectId) {
        const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
        if (!resolved.id) {
          return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
        }
        resolvedId = resolved.id
      }
      const { ok, data } = await callApi(
        'POST',
        '/prospects/import',
        { projectId: resolvedId, csvText, dedupPolicy },
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
          text: `Imported (${formatTarget(resolvedId)}): ${result.inserted} new, ${result.overwritten} overwritten, ${result.skipped} skipped, ${result.errors} errors.\nSkipped: ${JSON.stringify(result.skippedDetails)}\nErrors: ${JSON.stringify(result.errorDetails)}`,
        }],
      }
    },
  )

  server.tool(
    'get_outbound_targets',
    'Get uncontacted prospects ordered by priority for outbound outreach. Each prospect carries `country` (effective code = prospect override > org country > null) for pre-flight skipping against the currently-allowed US/CA/JP delivery scope.',
    {
      projectId: z.string().describe('Project name or ID'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max number of prospects to return'),
    },
    async ({ projectId, limit }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/prospects/reachable?limit=${limit}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as {
        prospects: unknown[]
        total: number
        byChannel: { email: number; formOnly: number; snsOnly: number }
        quota?: OutreachQuota
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
      const msgLine = result.message ? `\n⚠️ ${result.message}` : ''
      const modeLine = `\nOutbound mode: ${result.outboundMode}`

      return {
        content: [{
          type: 'text' as const,
          text: `Total reachable: ${result.total} (email: ${result.byChannel.email}, formOnly: ${result.byChannel.formOnly}, snsOnly: ${result.byChannel.snsOnly})${modeLine}${quotaLine}${msgLine}\nReturned: ${result.prospects.length}\n${JSON.stringify(result.prospects, null, 2)}`,
        }],
      }
    },
  )

  server.tool(
    'record_outreach_with_inquiry',
    'Pre-submit allocation for form / SNS DM channels: reserves the outreach log row (status="pre_send" in send mode, "pending_review" in draft mode) and returns finalBody with the inquiry-landing URL footer baked in (when project_settings.inquiryLandingEnabled=true). The skill submits finalBody verbatim, then resolves the row by calling update_outreach_status with "sent" on success or "failed" on failure. The prospect is flipped to "contacted" only on the "sent" transition. In draft mode the user submits manually from app.leadace.ai/drafts — no follow-up call needed. For email use send_email_and_record instead.',
    {
      projectId: z.string().describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['form', 'sns_twitter', 'sns_linkedin']),
      subject: z.string().optional(),
      body: z.string(),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('POST', '/outreach/record-with-inquiry', { ...input, projectId: resolved.id }, apiUrl, authHeader)
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

  server.tool(
    'update_outreach_status',
    'Resolve a "pre_send" outreach log row allocated by record_outreach_with_inquiry. Call with status="sent" after the form / SNS submit succeeds — the server flips the prospect to "contacted" and confirms quota consumption. Call with status="failed" plus an errorMessage if the submit fails — the in-flight quota reservation is refunded and next_outreach_after is stamped to sentAt + noResponseRecycleDays so the prospect drops out of get_outbound_targets for that window (existing longer windows are preserved via GREATEST). Only the "pre_send" → terminal transition is accepted.',
    {
      outreachLogId: z.number().int().positive().describe('outreachLogs.id from record_outreach_with_inquiry.'),
      status: z.enum(['sent', 'failed']).describe('"sent" = submit succeeded; "failed" = submit failed.'),
      errorMessage: z.string().min(1).max(2000).optional().describe('Required when status="failed". Reason for the submit failure (HTTP status, network error, etc.).'),
    },
    async ({ outreachLogId, status, errorMessage }) => {
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

  server.tool(
    'get_tenant_settings',
    'Get the workspace-level identity / compliance fields the user has configured. Returns { id, name, legalName, physicalAddress, contactEmail, defaultSenderCountry, privacyPolicyUrl }. legalName / physicalAddress / defaultSenderCountry are MANDATORY for outbound sends — when any of those is null, send_email_and_record / record_outreach_with_inquiry refuse with 412. /leadace uses this to direct the user to the Workspace settings page when fields are missing.',
    {},
    async () => {
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
        privacyPolicyUrl: string | null
        contactEmail: string | null
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
          text: `${status}\n\nlegalName: ${r.legalName ?? '(not set)'}\nphysicalAddress: ${r.physicalAddress ?? '(not set)'}\ndefaultSenderCountry: ${r.defaultSenderCountry ?? '(not set)'}\nprivacyPolicyUrl: ${r.privacyPolicyUrl ?? '(not set)'}\ncontactEmail: ${r.contactEmail ?? '(not set)'}`,
        }],
      }
    },
  )

  server.tool(
    'update_tenant_settings',
    'Update workspace-level identity / compliance fields. All fields are optional — only the keys you pass are written. legalName / physicalAddress / defaultSenderCountry are the three mandatory-for-outbound fields; setting them clears the 412 send-time refusal. defaultSenderCountry is the sender-side ISO 3166-1 alpha-2 code recorded in the compliance footer; any valid alpha-2 is accepted. It is independent from the recipient-delivery allowlist (which is enforced separately on prospect / organization country). Used by /leadace to interactively fill compliance during onboarding.',
    {
      name: z.string().min(1).max(120).optional().describe('Workspace display name (internal label).'),
      legalName: z.string().min(1).max(200).nullable().optional().describe('Registered business name shown in the email compliance footer (CAN-SPAM § 5(a)(5)).'),
      physicalAddress: z.string().min(5).max(500).nullable().optional().describe('Postal address shown in the email compliance footer (CAN-SPAM physical address requirement).'),
      contactEmail: z.email().max(254).nullable().optional().describe('Inbound contact / complaint routing address. Optional.'),
      defaultSenderCountry: z.string().regex(/^[A-Z]{2}$/, 'must be ISO 3166-1 alpha-2 (e.g. US, CA, JP)').nullable().optional(),
      privacyPolicyUrl: z.url().max(500).nullable().optional().describe('Public privacy policy URL. Optional but recommended.'),
    },
    async (patch) => {
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

  server.tool(
    'get_compliance_status',
    'Lightweight pre-flight check for outbound. Returns just { ready: boolean, missing: string[] } so callers can branch without parsing the full tenant settings payload. ready=false means at least one of legalName / physicalAddress / defaultSenderCountry is unset and any send_email_and_record / record_outreach_with_inquiry call will refuse with 412. Use this at the top of /outbound to bail early before spending tokens on draft generation.',
    {},
    async () => {
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

  server.tool(
    'list_subject_variants',
    'List the project\'s subject-line variants (active + archived) so /leadace can detect whether seeding is needed and /evaluate can review existing rotation. Returns `{ variants: [{ variantId, subjectPattern, label, archivedAt, ... }] }` ordered by createdAt asc.',
    {
      projectId: z.string().describe('Project name or ID'),
    },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/subject-variants`, null, apiUrl, authHeader)
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

  server.tool(
    'upsert_subject_variant',
    'Register or update a subject-line A/B variant on a project. variantId is a stable slug (e.g. "v1", "warm_intro", "signal_funded"); subjectPattern may include {{org}} / {{name}} / {{signal}} placeholders that the skill substitutes at send time. Setting archived=true retires the slug from rotation while keeping it analysable for historic outreach rows. Idempotent: re-calling with the same variantId updates the pattern / label / archived state. /leadace onboarding seeds the first 2-3 variants; /evaluate may suggest adding new ones based on response rates.',
    {
      projectId: z.string().describe('Project name or ID'),
      variantId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).describe('Stable slug, max 32 chars [A-Za-z0-9_-]'),
      subjectPattern: z.string().min(1).max(300).describe('Subject template; may use {{placeholders}}.'),
      label: z.string().min(1).max(120).nullable().optional().describe('Optional human-readable label for /evaluate.'),
      archived: z.boolean().optional().describe('Set true to retire the slug from rotation.'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { projectId: _, ...body } = input
      const { ok, data } = await callApi(
        'PUT',
        `/projects/${resolved.id}/subject-variants`,
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

  server.tool(
    'pick_subject_variant',
    'Pick the next active subject-line variant for the project via round-robin (project_settings.subject_variant_cursor advances by one per call, modulo the active variant count). Pass an explicit variantId to bypass rotation; unknown / archived ids fall through to round-robin. Returns { variantId, subjectPattern, label }. Email-only — the skill renders the pattern (substitutes {{org}} / {{name}} / {{signal}} placeholders) into the final subject and forwards variantId to send_email_and_record so outreach_logs.variant_id is stamped. NOT_FOUND when no active variants are registered — generate a one-off subject and send without variantId in that case.',
    {
      projectId: z.string().describe('Project name or ID'),
      variantId: z.string().min(1).max(32).optional().describe('Override round-robin with a specific variant id.'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const path = `/projects/${resolved.id}/subject-variants/pick${input.variantId ? `?variantId=${encodeURIComponent(input.variantId)}` : ''}`
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

  server.tool(
    'record_outreach',
    'Record an outreach log entry. status="sent" flips the prospect to "contacted". status="failed" REQUIRES errorMessage and stamps next_outreach_after = sentAt + noResponseRecycleDays (project setting, default 90) so the prospect drops out of get_outbound_targets for that window — covers both intentional skips (errorMessage starting with "skipped: …") and real send errors. status="pending_review" leaves the prospect unchanged but excludes it from get_outbound_targets while the draft is open. errorMessage is rejected with 400 on "sent" / "pending_review". For form / SNS DM where you intend to submit, prefer record_outreach_with_inquiry — it allocates the row pre-submit and returns finalBody with the inquiry-landing URL footer baked in.',
    {
      projectId: z.string().describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin']),
      subject: z.string().optional(),
      body: z.string(),
      status: z.enum(['sent', 'failed', 'pending_review']).default('sent')
        .describe('"sent" = delivered. "failed" = send error (errorMessage required). "pending_review" = draft created (outbound_mode = draft).'),
      errorMessage: z.string().min(1).max(2000).optional()
        .describe('Required when status="failed"; rejected when status="sent" or "pending_review".'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('POST', '/outreach', { ...input, projectId: resolved.id }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number }
      return { content: [{ type: 'text' as const, text: `Outreach logged (id: ${result.id}).` }] }
    },
  )

  server.tool(
    'skip_prospect',
    'Record a deliberate decision NOT to contact a prospect on this outbound run — no send is attempted. Use only for the LLM judgment calls the server cannot make: reason="bad_timing" (the prospect overview flags now as a bad moment — layoffs, wind-down, post-acquisition freeze) or reason="no_fresh_material" (a re-approach with nothing new to say). Writes a "skipped" audit row and stamps next_outreach_after = sentAt + noResponseRecycleDays so the prospect drops out of get_outbound_targets for that window (longer existing windows preserved via GREATEST). No quota is consumed and the prospect is NOT marked contacted. Do NOT use this for unsupported-country prospects — get_outbound_targets already filters those server-side.',
    {
      projectId: z.string().describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin'])
        .describe('The channel the run was about to use. Recorded on the audit row only; no send happens.'),
      reason: z.enum(['bad_timing', 'no_fresh_material', 'other'])
        .describe('Structured skip reason. "bad_timing" / "no_fresh_material" are the common cases; "other" is an escape hatch.'),
      note: z.string().min(1).max(2000).optional()
        .describe('Optional one-line context shown in the recent-outreach feed.'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('POST', '/outreach/skip', { ...input, projectId: resolved.id }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number }
      return { content: [{ type: 'text' as const, text: `Prospect skipped (${input.reason}; audit id: ${result.id}).` }] }
    },
  )

  server.tool(
    'get_gmail_status',
    'Check whether the current user has connected their Google account (gmail.send scope) via the LeadAce web app. Returns the connected Gmail address or an indication that Gmail is not connected.',
    {},
    async () => {
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

  server.tool(
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
    async (input) => {
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

  server.tool(
    'send_email_and_record',
    'Compose and submit a prospect email + outreach log in one call. The server reads the project\'s outboundMode setting and either sends via the user\'s Gmail (mode "send") or stores a pending_review draft for the user to send from the LeadAce web app (mode "draft"). Skills should call this regardless of mode — do not branch on outboundMode in skill logic.',
    {
      projectId: z.string().describe('Project name or ID'),
      prospectId: z.number().int(),
      to: z.array(z.email()).min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.array(z.email()).optional(),
      bcc: z.array(z.email()).optional(),
      inReplyTo: z.string().optional().describe('Gmail Message-Id header for threading'),
      variantId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).optional().describe('Subject variant id from pick_subject_variant. Stamps outreach_logs.variant_id so /evaluate can join reply rates per variant.'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi(
        'POST',
        '/outreach/send-and-record',
        { ...input, projectId: resolved.id },
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
        ? `Email sent (Gmail messageId: ${result.messageId}, threadId: ${result.threadId}). Outreach logged (id: ${result.outreachId}).`
        : `Draft created (outreach id: ${result.outreachId}). User reviews and sends from https://app.leadace.ai/drafts.`
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  server.tool(
    'discard_drafts',
    'Batch-delete pending_review drafts. Pass either ids (explicit list, max 200) for selective cleanup, or projectId to wipe every pending_review draft in that project. Already-sent / failed rows are silently excluded. Returns deletedIds + skippedIds (the latter only meaningful in id-list mode — ids that did not match a pending_review row in this tenant).',
    {
      ids: z.array(z.number().int().positive()).min(1).max(200).optional()
        .describe('Explicit list of outreach log ids to discard. Mutually exclusive with projectId.'),
      projectId: z.string().optional()
        .describe('Project name or ID. When set (and ids omitted), wipes every pending_review draft in that project. Mutually exclusive with ids.'),
    },
    async ({ ids, projectId }) => {
      if ((ids && projectId) || (!ids && !projectId)) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: pass exactly one of ids or projectId.',
          }],
          isError: true,
        }
      }
      let body: { ids: number[] } | { allInProjectId: string }
      if (ids) {
        body = { ids }
      } else {
        const resolved = await resolveProjectId(projectId!, apiUrl, authHeader)
        if (!resolved.id) {
          return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
        }
        body = { allInProjectId: resolved.id }
      }
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

  server.tool(
    'update_prospect_status',
    'Update the status of a prospect in a project (e.g. mark as inactive, rejected).',
    {
      projectId: z.string().describe('Project name or ID'),
      prospectId: z.number().int(),
      status: z.enum(prospectStatusEnum.enumValues),
    },
    async ({ projectId, prospectId, status }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi(
        'PATCH',
        `/prospects/${prospectId}/status`,
        { projectId: resolved.id, status },
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

  server.tool(
    'update_organization',
    'Partial-update an organization\'s name or website URL. Domain is immutable (it is the per-tenant dedup key). Use when /build-list or imports created the org with a stale name (e.g., before a rebrand) and the visible name needs correcting. organizationId is the integer PK from get_organizations / org listings, not a domain.',
    {
      organizationId: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
      }).describe('Fields to update. At least one required.'),
    },
    async ({ organizationId, patch }) => {
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

  server.tool(
    'update_prospect',
    'Partial-update a tenant prospect\'s fields (organization-level columns: name / contactName / department / overview / industry / websiteUrl / email / contactFormUrl / formType / snsAccounts / notes / hypothesis / country / countrySource). Only the keys you pass are written; null clears a nullable field. The prospect must keep at least one contact channel (email, contactFormUrl, or any snsAccounts entry) — UNPROCESSABLE if the patch would leave none. CONFLICT when email or contactFormUrl already belongs to another prospect in the workspace. For per-project status / matchReason / priority use update_prospect_status (status) — those columns live on the project_prospects junction. For DNC use set_prospect_do_not_contact.',
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
    async ({ prospectId, patch }) => {
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

  server.tool(
    'set_prospect_do_not_contact',
    'Toggle the do_not_contact flag on a tenant prospect. Use after /import-prospects when the source had no DNC column but you know certain rows are unsubscribed/opted-out, or for ad-hoc DNC management outside the response-recording flow. DNC prospects are excluded from /build-list re-discovery and from outbound targeting.',
    {
      prospectId: z.number().int(),
      doNotContact: z.boolean().describe('true to mark do-not-contact; false to clear the flag.'),
    },
    async ({ prospectId, doNotContact }) => {
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

  server.tool(
    'get_recent_outreach',
    'Get recent outreach logs for a project. Used by check-results to match Gmail/SNS replies to sent messages. Each log carries the recipient identifiers (prospectName, contactName, prospectEmail, organizationDomain) so the skill can match by domain and name leads in the report without a second lookup. Each log also carries inquiry-landing aggregates: inquirySessionCount, inquiryOutcome (opened / inquired / unsubscribed / signup_clicked / lead / null — most-significant outcome ever recorded; signup_clicked is the self-serve counterpart to lead, surfaced only when the project runs in inquiryCtaType="signup"), inquiryMeetingSource (button / chat / null — only set when inquiryOutcome === "lead"), inquiryLastVisitAt — surface lead-via-landing and signup-via-landing alongside email replies, and skip reply-draft creation for outreach where the recipient already became a lead or signup via the inquiry page.',
    {
      projectId: z.string().describe('Project name or ID'),
      limit: z.number().int().min(1).max(200).default(100),
    },
    async ({ projectId, limit }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/outreach/recent?limit=${limit}`, null, apiUrl, authHeader)
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

  server.tool(
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
    async (input) => {
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

  server.tool(
    'get_rejection_feedback_summary',
    'Aggregate rejection_feedback. With scope="pmf" returns the PMF slice (feature_gap, already_have_solution, competitor_locked) — primary_reason distribution + feature_gap free-text notes, with total and percentages computed within the PMF subset. Used by /check-feedback. With scope="tactical" returns the non-PMF slice — primary_reason distribution + recontactWindows (per-bucket count + samples for every RejectionRecontactWindow value: "never", "3_months", "6_months", "12_months", "unspecified" — empty buckets carry {count:0,samples:[]}) + decision_maker_pointer + not_relevant notes (with industry context). Used by /evaluate to drive targeting; recontact-window prospects are auto-deferred and decision_maker_pointer rows auto-create or update prospects at record_response time, both surface here as a transparency log only. scope="all" (default) returns the unfiltered union.',
    {
      projectId: z.string().describe('Project name or ID'),
      windowDays: z.number().int().min(1).max(3650).optional().describe('Restrict to rejections received within the last N days. Omit for all-time.'),
      scope: z.enum(['pmf', 'tactical', 'all']).optional().describe('"pmf" → PMF slice only; "tactical" → non-PMF slice only; "all" (default) → unfiltered union.'),
    },
    async ({ projectId, windowDays, scope }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const params = new URLSearchParams()
      if (windowDays != null) params.set('windowDays', String(windowDays))
      if (scope != null) params.set('scope', scope)
      const qs = params.toString() ? `?${params.toString()}` : ''
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/rejection-feedback/summary${qs}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  server.tool(
    'get_eval_data',
    'Get evaluation statistics for a project: response rates, channel performance, sentiment breakdown, and inquiry-landing outcome counts (opened / inquired / lead / signup_clicked / unsubscribed). Also returns responded message bodies and a data sufficiency check.',
    { projectId: z.string().describe('Project name or ID') },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/stats`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      }
    },
  )

  server.tool(
    'record_evaluation',
    'Record an evaluation result and optionally bulk-update prospect priorities by industry.',
    {
      projectId: z.string().describe('Project name or ID'),
      metrics: z.record(z.string(), z.unknown()).describe('Summary metrics (from get_eval_data, excluding respondedMessages/noResponseSample)'),
      findings: z.string().describe('Analysis findings text'),
      improvements: z.string().describe('Improvement actions applied (free text or JSON)'),
      priorityUpdates: z.array(z.object({
        industry: z.string(),
        priority: prioritySchema,
      })).optional().describe('Bulk priority updates by industry'),
    },
    async (input) => {
      const resolved = await resolveProjectId(input.projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('POST', '/evaluations', { ...input, projectId: resolved.id }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { evaluationId: number; priorityUpdates: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: `Evaluation recorded (id: ${result.evaluationId}). Priority updates: ${JSON.stringify(result.priorityUpdates)}`,
        }],
      }
    },
  )

  server.tool(
    'get_evaluation_history',
    'Get past evaluation records for a project (findings, improvements, dates).',
    { projectId: z.string().describe('Project name or ID') },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/evaluations`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const { evaluations } = data as { evaluations: unknown[] }
      return {
        content: [{
          type: 'text' as const,
          text: evaluations.length === 0
            ? 'No evaluations recorded yet.'
            : `${evaluations.length} evaluation(s).\n${JSON.stringify(evaluations, null, 2)}`,
        }],
      }
    },
  )

  server.tool(
    'get_document',
    'Get the latest version of a project document (business, sales_strategy, search_notes).',
    {
      projectId: z.string().describe('Project name or ID'),
      slug: z.string().describe('Document slug: "business", "sales_strategy", or "search_notes"'),
    },
    async ({ projectId, slug }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, status, data } = await callApi('GET', `/projects/${resolved.id}/documents/${slug}`, null, apiUrl, authHeader)
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

  server.tool(
    'save_document',
    'Save a new version of a project document. Appends a new version (immutable); previous versions are preserved.',
    {
      projectId: z.string().describe('Project name or ID'),
      slug: z.string().describe('Document slug: "business", "sales_strategy", or "search_notes"'),
      content: z.string().describe('Full markdown content of the document'),
    },
    async ({ projectId, slug, content }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('PUT', `/projects/${resolved.id}/documents/${slug}`, { content }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number; slug: string; createdAt: string }
      return { content: [{ type: 'text' as const, text: `Document "${slug}" saved (version id: ${result.id}).` }] }
    },
  )

  server.tool(
    'list_documents',
    'List all documents for a project with their last updated timestamps.',
    {
      projectId: z.string().describe('Project name or ID'),
    },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/documents`, null, apiUrl, authHeader)
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

  server.tool(
    'get_master_document',
    'Get a master document (shared templates, guidelines, frameworks) by slug.',
    {
      slug: z.string().describe('Master document slug (e.g. "tpl_business", "tpl_email_guidelines")'),
    },
    async ({ slug }) => {
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

  server.tool(
    'list_master_documents',
    'List all available master documents (templates, guidelines, frameworks).',
    {},
    async () => {
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

  server.tool(
    'list_tenant_prospects',
    'List existing prospects across the entire tenant (every project the user owns). Use this in /match-prospects to find prospects gathered for past projects that may fit the current project. Excludes do-not-contact prospects. excludeProjectId omits prospects already linked to that project. q is a substring match on name / overview / industry / organization name. Returns up to 1000 rows.',
    {
      excludeProjectId: z.string().optional()
        .describe('Project name or ID — omit prospects already linked to this project'),
      q: z.string().optional().describe('Substring search on name / overview / industry / org name'),
      industry: z.string().optional().describe('Exact-match industry filter'),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    async ({ excludeProjectId, q, industry, limit }) => {
      const params = new URLSearchParams()
      if (excludeProjectId) {
        const resolved = await resolveProjectId(excludeProjectId, apiUrl, authHeader)
        if (!resolved.id) {
          return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
        }
        params.set('excludeProjectId', resolved.id)
      }
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

  server.tool(
    'link_existing_prospects_to_project',
    'Link existing tenant prospects to a project by creating project_prospects junction rows. Does NOT create new prospects or organizations — pair with list_tenant_prospects to discover candidates first. Skips prospects flagged do_not_contact and reports prospects already linked. Use this in /match-prospects after the LLM picks targets and the user approves.',
    {
      projectId: z.string().describe('Project name or ID'),
      links: z.array(z.object({
        prospectId: z.number().int(),
        matchReason: z.string().min(1).describe('Why this prospect fits the current project'),
        priority: prioritySchema.default(3),
      })).min(1).max(200),
    },
    async ({ projectId, links }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi(
        'POST',
        `/projects/${resolved.id}/prospects/link`,
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

  server.tool(
    'create_inquiry_token',
    'Allocate a stable inquiry landing short_id + URL for an outreach. Idempotent on outreachLogId — repeated calls for the same live outreach return the same shortId so the URL stays valid across retried sends. Outbound skills MUST call this before sending email/form/SNS so the recipient has a single landing page (resources, AI chat, meeting-request button, unsubscribe with optional reason). Returns { shortId, inquiryUrl } — embed inquiryUrl in the outbound message body.',
    {
      outreachLogId: z.number().int().positive().describe('outreachLogs.id returned by record_outreach.'),
    },
    async ({ outreachLogId }) => {
      const { ok, data } = await callApi('POST', '/inquiry/tokens', { outreachLogId }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string; detail?: string }
        const msg = err.detail ? `${err.error}: ${err.detail}` : err.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { shortId: string; inquiryUrl: string }
      return {
        content: [{
          type: 'text' as const,
          text: `Inquiry URL ready: ${result.inquiryUrl} (shortId: ${result.shortId}).`,
        }],
      }
    },
  )

  server.tool(
    'get_inquiry_session_summary',
    'Sender-side visibility into a recipient\'s inquiry-landing activity for a given shortId. Returns the prospect/outreach context plus every session opened against this short_id (most recent first), each with outcome (opened / inquired / lead / signup_clicked / unsubscribed), meetingRequestSource (button / chat / null — only set when outcome === "lead"), derivedSummary, chatTurnsUsed, openedAt / closedAt, and the chat message thread. Use in /check-results to surface inquiry-landing outcomes alongside email replies.',
    {
      shortId: z.string().describe('Inquiry landing short_id (from create_inquiry_token).'),
    },
    async ({ shortId }) => {
      const { ok, status, data } = await callApi('GET', `/inquiry/sessions/${shortId}/summary`, null, apiUrl, authHeader)
      if (!ok) {
        if (status === 404) {
          return { content: [{ type: 'text' as const, text: `Inquiry token "${shortId}" not found.` }] }
        }
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  server.tool(
    'get_project_settings',
    'Get user-editable project settings (outboundMode, senderEmailAlias, senderDisplayName, senderCompanyName, senderJobTitle, unsubscribeEnabled, outboundChannels, targetCountries, ...). Returns defaults if no row exists yet. Skills should call this before strategy/build-list/outbound/daily-cycle to honor user-controlled behavior — especially outboundChannels (skip prospects whose only channel is disabled) and targetCountries (narrow discovery / exclude prospects outside the allowlist when non-empty).',
    { projectId: z.string().describe('Project name or ID') },
    async ({ projectId }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('GET', `/projects/${resolved.id}/settings`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  server.tool(
    'update_project_settings',
    'Update user-editable project settings. Any omitted field keeps its current value. Pass null to clear nullable fields.',
    {
      projectId: z.string().describe('Project name or ID'),
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
      outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).optional()
        .describe('Channels the project is allowed to use for outbound. Subset of {email, form, sns_twitter, sns_linkedin}. Default is all four. Narrow this when the operator wants to avoid less-stable browser-driven channels — skills must skip prospects whose only reachable channel is disabled. An empty array effectively pauses the project for outbound.'),
      targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).optional()
        .describe('ISO 3166-1 alpha-2 codes that further narrow the compliance-level send allowlist (currently US / CA / JP). Empty array (default) = no project-level restriction. Non-empty = explicit allowlist; /build-list focuses discovery on these countries and /outbound excludes prospects outside the set in addition to the unchanged send-time compliance gate.'),
    },
    async ({ projectId, ...patch }) => {
      const resolved = await resolveProjectId(projectId, apiUrl, authHeader)
      if (!resolved.id) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true }
      }
      const { ok, data } = await callApi('PUT', `/projects/${resolved.id}/settings`, patch, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  return server
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      console.error('Unhandled error:', e)
      return withCors(Response.json(
        { error: 'Internal server error', detail: e instanceof Error ? e.message : undefined },
        { status: 500 },
      ))
    }
  },
}

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
  const server = createMcpServer(env.WEB_API_URL, authHeader)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true, // Return JSON instead of SSE streams (Workers compat)
  })

  await server.connect(transport)
  return withCors(await transport.handleRequest(request))
}
