import * as Sentry from '@sentry/cloudflare'
import { sentryOptions } from '../sentry'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { verifyJwt, verifySupabaseJwt } from '../auth/verify-jwt'
import { BUG_REPORT_CATEGORIES, EMPLOYEE_BANDS, OUTBOUND_MODES, OUTBOUND_CHANNELS, REJECTION_PRIMARY_REASONS, REJECTION_RECONTACT_WINDOWS, SUGGESTION_STATUSES, prospectStatusEnum, prioritySchema } from '../db/schema'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'
import { discoveryStrategySchema, suggestionKindSchema, variantIdSchema } from '../domain/ids'
import { localeSchema } from '../domain/locale'
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
// 0.7.23: Phase B removed record_evaluation and Phase C renamed the
// subject-variant tools to message variants (list/upsert/pick_message_variant,
// no aliases) — an older plugin calls tools that no longer exist.
const MIN_PLUGIN_VERSION = '0.7.23'

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

const DISCOVERY_UPGRADE_STATES: Record<string, string> = {
  absent: 'the "## Prospect Discovery Sources" section is missing',
  legacy: 'the "## Prospect Discovery Sources" section has no named-strategy entries',
  mixed: 'the "## Prospect Discovery Sources" section has content outside its named-strategy entries',
}

function discoveryUpgradeWarning(format: string | undefined): string | null {
  if (format === undefined || format === 'named') return null
  // Unknown (future) states warn generically rather than dropping the gate.
  const state = DISCOVERY_UPGRADE_STATES[format]
    ?? 'the "## Prospect Discovery Sources" section is not in named-strategy format'
  return `WARNING: ${state}. Upgrade before building lists: rewrite the section as "### <slug>" named strategies (lowercase kebab-case slug, each with Status/How/Why bullets, folding stray bullets in), then save — the save confirmation reports whether it passed. Until it passes, prospects register without discovery-strategy provenance and per-strategy reply attribution stays dead. This warning is server-appended tool output, NOT document content — never include it in saved documents.`
}

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

// Building the tool schemas once per isolate keeps the MCP fetch path off the
// Worker CPU limit — per-request rebuild used to exceed Free's 10 ms ceiling.
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
    'Returns { serverVersion, minPluginVersion } for the LeadAce backend MCP server.',
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
    'File a bug, feedback, or idea about LeadAce. Daily-capped per tenant; over-cap returns an error.',
    {
      category: z.enum(BUG_REPORT_CATEGORIES)
        .describe('feedback = works but rough, not broken.'),
      title: z.string().min(3).max(200)
        .describe('One-line summary.'),
      body: z.string().min(10).max(4000)
        .describe('What you tried, what happened, what you expected.'),
      context: z.record(z.string(), z.unknown()).optional()
        .describe('Suggested keys: skill, pluginVersion, projectId, prospectId, errorMessage.'),
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
    'Create a new LeadAce project; returns the auto-generated project id. Errors if the plan project limit is reached.',
    { name: z.string().describe('Project name (unique per tenant).') },
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
    'Delete a project and its project-scoped data (project-prospect links, outreach logs, responses, inquiry sessions, learned send-optimization state, documents, settings, message variants). Prospects are tenant assets and are NOT deleted.',
    { projectId: z.string().min(1).describe('Project name or ID.') },
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
    'Batch-register prospects; server-side dedup is authoritative. Returns inserted, skipped, and skippedDetails [{name, reason, detail?}]. Rows whose industry is not in the tpl_industries vocabulary are skipped (reason unknown_industry) — fix and re-register.',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID; omit to save prospects tenant-only (no project link).'),
      prospects: z.array(z.object({
        organizationDomain: z.string().describe('Organization domain; apex preferred (example.com), but raw URLs and www. prefix are normalized server-side.'),
        organizationName: z.string(),
        organizationWebsiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
        name: z.string().describe('Prospect name (company, school, department, etc.).'),
        contactName: z.string().optional(),
        department: z.string().optional(),
        overview: z.string(),
        industry: z.string().optional().describe('Exact value from the tpl_industries vocabulary (master document); unknown values skip the row.'),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
        email: z.email().optional().describe('At least one contact channel (email / contactFormUrl / snsAccounts / platformUrl) required.'),
        emailSourceUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional().describe('Page the address was published on. Also the legal record for the published-address exemption, so it must be the page actually carrying the address, not a homepage guess. Omit when the address did not come from a public page.'),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        formType: z.enum(['google_forms', 'native_html', 'wordpress_cf7', 'iframe_embed', 'with_captcha']).optional(),
        snsAccounts: z.object({
          x: z.string().optional(),
          linkedin: z.string().optional(),
          instagram: z.string().optional(),
          facebook: z.string().optional(),
        }).optional(),
        platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional()
          .describe('External-platform action page (posting/listing) answered in-platform via the "platform" channel; dedup is by this URL (posting granularity).'),
        notes: z.string().optional(),
        hypothesis: z.object({
          targetDepartment: z.string().optional().describe('Likely buyer department.'),
          targetRolePattern: z.string().optional().describe('Likely buyer role/title pattern.'),
          hypothesizedPain: z.array(z.string()).optional().describe('Short pain hypotheses.'),
          valueMapping: z.array(z.string()).optional().describe('How the offering addresses each pain, in the same order as hypothesizedPain.'),
          timingSignals: z.array(z.string()).optional().describe('Concrete reasons now is a good moment to reach out.'),
          bestChannel: z.string().optional().describe('Suggested first channel (e.g. personal_email, form, linkedin_dm).'),
          bestKeyperson: z.string().optional().describe('Specific keyperson if obvious (name + role).'),
        }).optional().describe('Per-prospect targeting hypothesis.'),
        doNotContact: z.boolean().optional().describe('Marks the prospect do-not-contact (unsubscribed/opted-out). On overwrite, true sets the flag; false never clears an existing one (one-way ratchet).'),
        matchReason: z.string().optional().describe('Why this prospect is a good target. Required when projectId is set; ignored otherwise.'),
        priority: prioritySchema.default(3),
        discoveryStrategy: discoveryStrategySchema.optional().describe('Slug of the discovery strategy that found this prospect. Write-once provenance.'),
        country: z.string().regex(/^[A-Z]{2}$/).optional().describe('Prospect country (ISO 3166-1 alpha-2). When the organization is first created it also bootstraps the org country (an existing org keeps its value, so it acts as a per-prospect override). Codes outside the send-allowed set register fine but are blocked at outreach time.'),
        countrySource: z.enum(['manual', 'ai_inferred']).optional().describe('Provenance of the country value; only meaningful when country is set.'),
        employeeBand: z.enum(EMPLOYEE_BANDS).optional().describe('Coarse company-size band of the organization. Applied on the org\'s first registration only — a dedup-matched existing org keeps its value (change via update_organization). Omit = unknown.'),
      })).describe('Max 100 per call.'),
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
    'Read-only duplicate pre-check. Returns decisions[] in input order, each {kind: \'fresh\' | \'skip\', reason?}; reasons are the dedup subset of add_prospects (no plan_limit).',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID; omit for tenant-scope dedup only (no project-link check).'),
      candidates: z.array(z.object({
        organizationDomain: z.string().describe('Organization domain; apex preferred (example.com), but raw URLs and www. prefix are normalized server-side.'),
        email: z.email().optional(),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
      })).describe('Max 100 per call.'),
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
    'Import prospects from a canonical CSV string. Returns inserted, overwritten, skipped, errors, skippedDetails [{row, name, reason}], and errorDetails. dedupPolicy \'overwrite\' refreshes prospects matched by email, contactFormUrl, or platformUrl and re-links them, but domain-only matches skip as already_in_project and do_not_contact rows are always skipped; doNotContact is a one-way ratchet on overwrite (true sets it, false/absent never clears). Max 1000 data rows.',
    {
      projectId: z.string().min(1).optional().describe('Project name or ID; omit to save prospects tenant-only (no project link).'),
      csvText: z.string().describe('Full CSV text including header row.'),
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
    'Lists the ISO 3166-1 alpha-2 country codes LeadAce recognizes for a prospect/organization `country`. Returns { countries: [{ code, name, sendAllowed }], sendAllowed, note }; sendAllowed marks codes outreach can currently deliver to, others store but are blocked at send time.',
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
    'Prospects due for outreach (new + follow-up/recycle touches), ordered by the measured targeting score (x priority multiplier; a share of each batch is random exploration slots); server-filters by enabled channels and deliverable country (unknown country passes unless the project sets targetCountries). Reports the reachable total and its email / formOnly / snsOnly / platformOnly split, the outbound mode (send|draft), remaining outreach quota, and the mailbox email cap; then the prospects as JSON, each carrying `country`, `discoveryStrategy`, and `cycle` {kind, touchNumber}.',
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
        byChannel: { email: number; formOnly: number; snsOnly: number; platformOnly: number }
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
          text: `Total reachable: ${result.total} (email: ${result.byChannel.email}, formOnly: ${result.byChannel.formOnly}, snsOnly: ${result.byChannel.snsOnly}, platformOnly: ${result.byChannel.platformOnly})${modeLine}${quotaLine}${mailboxLine}${msgLine}\nReturned: ${result.prospects.length}\n${JSON.stringify(result.prospects, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'get_mailbox_health',
    'Warmup and daily-cap state of the mailbox this project sends from (assigned custom mailbox, else connected Gmail). This per-mailbox email cap is separate from the plan/billing outreach quota — email sends only, resets at UTC midnight. Returns the mailbox email, warmup ramp (week X of N) or fixed cap override, today\'s cap/used/remaining, any pause, and a trailing 30-day bounceRate (threaded-only lower bound). Returns a no-mailbox state when the project has no assigned mailbox and no linked Gmail.',
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
            bounceWindowDays: number
            sentInWindow: number
            bounced: number
            bounceRate: number
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
        h.sentInWindow === 0
          ? `Bounces (last ${h.bounceWindowDays}d): no threadable email sends yet`
          : `Bounces (last ${h.bounceWindowDays}d): ${h.bounced}/${h.sentInWindow} = ${h.bounceRate}% (threaded-only lower bound). If elevated, review list/source quality and consider pausing this mailbox at app.leadace.ai.`,
      ]
      if (h.pausedUntil) lines.push(`⚠️ Sending PAUSED until ${h.pausedUntil}`)
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    },
  )

  defineTool(
    'record_outreach_with_inquiry',
    'Reserve an outreach log row for a form / SNS DM / platform channel before submission. Returns outreachLogId, status ("pre_send" in send mode, "pending_review" in draft mode), inquiryUrl, and finalBody — the body with the compliance footer (legal identity + opt-out line, plus an inquiry-landing URL line when inquiryLandingEnabled) appended; channel "platform" gets no footer (solicited in-platform message). The "pre_send" row must be resolved by update_outreach_status ("sent" / "failed"); a "pending_review" row needs no follow-up call. For email use send_email_and_record instead.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['form', 'sns_twitter', 'sns_linkedin', 'platform']),
      subject: z.string().optional(),
      body: z.string(),
      variantId: variantIdSchema.optional().describe('Message variant id from pick_message_variant.'),
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
    'Resolve the "pre_send" outreach log row from record_outreach_with_inquiry. Both terminal transitions stamp next_outreach_after = sentAt + noResponseRecycleDays, dropping the prospect from get_outbound_targets for that window: status="sent" also flips the prospect to "contacted", confirms quota consumption, and advances the follow-up sequence; status="failed" refunds the in-flight quota reservation. Only the "pre_send" → terminal transition is accepted.',
    {
      outreachLogId: z.number().int().positive().describe('outreachLogs.id from record_outreach_with_inquiry.'),
      status: z.enum(['sent', 'failed']).describe('"sent" = submit succeeded; "failed" = submit failed.'),
      errorMessage: z.string().min(1).max(2000).optional().describe('Required when status="failed".'),
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
    'Returns the workspace identity/compliance fields (legalName, physicalAddress, defaultSenderCountry) plus a readiness status line; all three gate outbound: send tools refuse (412) until each is set.',
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
    'Updates workspace identity/compliance fields; only the keys passed are written (merge, not replace). legalName, physicalAddress, defaultSenderCountry gate outbound: send tools refuse (412) until all are set. defaultSenderCountry is the sender\'s own country, separate from recipient targeting and message language.',
    {
      name: z.string().min(1).max(120).optional().describe('Workspace display name (internal label).'),
      legalName: z.string().min(1).max(200).nullable().optional().describe('Registered business name shown in the email compliance footer.'),
      physicalAddress: z.string().min(5).max(500).nullable().optional().describe('Postal address shown in the email compliance footer.'),
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
    'Pre-flight compliance check for outbound. Reports ready or incomplete, with the unset fields. Incomplete means at least one of legalName / physicalAddress / defaultSenderCountry is missing, and send_email_and_record / record_outreach_with_inquiry then refuse with 412.',
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
    'list_message_variants',
    'List the project\'s message-angle variants. Reports the active / archived counts, then the variants as JSON — [{ variantId, subjectPattern, bodyApproach, label, archivedAt, … }] ordered by createdAt asc.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
    },
    async ({ projectId }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/message-variants`, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { variants: Array<{ variantId: string; subjectPattern: string; bodyApproach: string | null; label: string | null; archivedAt: string | null }> }
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
    'upsert_message_variant',
    'Register or update a message-angle variant (subject pattern + optional body approach) on a project. Idempotent by variantId — re-calling updates that variant\'s fields / archived state. archived=true retires it from rotation but keeps it analysable for historic outreach rows. Refused (400) when it would push the active count past the project\'s cap.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      variantId: variantIdSchema,
      subjectPattern: z.string().min(1).max(300).describe('Subject template; may embed {{placeholders}} substituted at send time.'),
      bodyApproach: z.string().min(1).max(2000).nullable().optional().describe('Angle brief (2-5 lines: structure / tone / CTA type / length / opener policy) the body is written from; null clears it back to the email_template default skeleton.'),
      label: z.string().min(1).max(120).nullable().optional().describe('Human-readable display label; null clears it.'),
      archived: z.boolean().optional().describe('Omit to leave the archived state unchanged; false un-archives.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const { projectId, ...body } = input
      const { ok, data } = await callApi(
        'PUT',
        `/projects/${encodeURIComponent(projectId)}/message-variants`,
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
      return { content: [{ type: 'text' as const, text: `Message variant ${result.variantId} saved (${status}).` }] }
    },
  )

  defineTool(
    'pick_message_variant',
    'Pick an active message-angle variant for the project via a server-side weighted draw. Returns the drawn variant id, its subject pattern, its body approach (line absent when the variant has none), and label; NOT_FOUND when the project has no active variants.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      variantId: variantIdSchema.optional().describe('A specific active variant id to bypass the weighted draw; an unknown or archived id silently falls through to the draw.'),
    },
    async (input, { apiUrl, authHeader }) => {
      const path = `/projects/${encodeURIComponent(input.projectId)}/message-variants/pick${input.variantId ? `?variantId=${encodeURIComponent(input.variantId)}` : ''}`
      const { ok, data } = await callApi('POST', path, null, apiUrl, authHeader)
      if (!ok) {
        const e = data as { error: string; detail?: string }
        const msg = e.detail ? `${e.error}: ${e.detail}` : e.error
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
      const result = data as { variantId: string; subjectPattern: string; bodyApproach: string | null; label: string | null }
      const labelLine = result.label ? `\nLabel: ${result.label}` : ''
      const approachLine = result.bodyApproach ? `\nBody approach: ${result.bodyApproach}` : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Picked variant: ${result.variantId}${labelLine}\nSubject pattern: ${result.subjectPattern}${approachLine}`,
        }],
      }
    },
  )

  defineTool(
    'run_lever_tick',
    'Run the project\'s daily outbound-optimization tick: recompute the message-variant draw weights pick_message_variant reads (Thompson sampling over graded reward; archives variants whose P(best) stays below the threshold at maturity, never below two active), the per-industry channel affinity get_outbound_targets surfaces, and the measured targeting lifts (industry / size / country / discovery strategy / fresh signal) that re-score the get_outbound_targets ordering. After a sustained flat streak (every arm mature yet none likely best) it rotates out the weakest arm to free a slot for a fresh angle. Idempotent per UTC day — a repeat call returns that day\'s recorded decision without re-applying. Returns weights, archived variants (a stagnation rotation is marked as such), per-variant samples, channelAffinity by industry bucket, targeting lifts, and needsReplenishment (recomputed live each call, not the frozen recorded value; stays raised while a rotation-freed slot is unfilled).',
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
        archived: Array<{ variantId: string; reason?: string }>
        samples: Array<{ variantId: string; total: number }>
        channelAffinity: Record<string, Array<{ channel: string; rate: number; total: number; responses: number }>>
        targetingLifts: Record<string, unknown> | null
        needsReplenishment: boolean
      }
      const mature = r.samples.filter((s) => s.total >= r.minSamplePerArm).length
      const head = r.ran
        ? `Lever tick ran for ${r.cycleDate}.`
        : `Lever tick already ran for ${r.cycleDate} (no change).`
      const archivedLine = r.archived.length > 0
        ? ` Archived: ${r.archived.map((a) => a.reason === 'stagnation' ? `${a.variantId} (stagnation rotation)` : a.variantId).join(', ')}.`
        : ''
      const buckets = Object.keys(r.channelAffinity)
      const channelLine = buckets.length > 0
        ? `\nChannel affinity (${buckets.length} industry bucket(s)): ${JSON.stringify(r.channelAffinity)}`
        : '\nChannel affinity: none yet (cells under min-sample → policy order).'
      const targetingLine = r.targetingLifts
        ? `\nTargeting lifts: ${JSON.stringify(r.targetingLifts)}`
        : '\nTargeting lifts: none recorded for this cycle (pre-upgrade decision).'
      const replenishLine = r.needsReplenishment
        ? '\nReplenishment: a fresh angle is needed (pool below target, or a rotation freed a slot that is unfilled) — /evaluate should supply one.'
        : ''
      return {
        content: [{
          type: 'text' as const,
          text: `${head} ${mature}/${r.samples.length} variant(s) at min-sample (${r.minSamplePerArm}).${archivedLine}\nWeights: ${JSON.stringify(r.weights)}${channelLine}${targetingLine}${replenishLine}`,
        }],
      }
    },
  )

  defineTool(
    'get_lever_state',
    'Read-only snapshot of the project\'s outbound optimizer: message-variant draw weights (null until the first tick → uniform), channel affinity per coarse-industry bucket ({} until measured → policy order), targetingLifts (null until a tick has computed them → neutral ordering), updatedAt, per-active-variant mature-sample progress, today\'s tick decision if it ran, and needsReplenishment (also true while a stagnation-rotation slot awaits its fresh angle).',
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
    'Read-only history of the project\'s daily lever-tick decisions, newest first. Each entry is one UTC day: message-variant draw weights, variants archived that day (reason "stagnation" marks a rotation, absent = dominated), per-variant sample counts, channel affinity per coarse-industry bucket, and targetingLifts (null on pre-upgrade entries). Empty until the tick has run at least once.',
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
    'Record an outreach log entry. status="sent" flips the prospect to "contacted" and stamps next_outreach_after = sentAt + noResponseRecycleDays so it recycles back into get_outbound_targets only after that window; status="failed" stamps the same window without marking the prospect contacted so it drops out of get_outbound_targets for it; status="pending_review" leaves the prospect unchanged but excludes it from get_outbound_targets while the draft is open. For form / SNS DM submissions, prefer record_outreach_with_inquiry.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin', 'platform']),
      subject: z.string().optional(),
      body: z.string(),
      variantId: variantIdSchema.optional().describe('Message variant id from pick_message_variant.'),
      status: z.enum(['sent', 'failed', 'pending_review']).default('sent')
        .describe('"sent" = delivered; "failed" = send error; "pending_review" = draft created.'),
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
    'Record a deliberate skip of a prospect on this outbound run — no send is attempted. Writes a "skipped" audit row and stamps next_outreach_after = sentAt + noResponseRecycleDays so the prospect drops out of get_outbound_targets for that window; no quota is consumed and the prospect is NOT marked contacted. Not for unsupported-country prospects — get_outbound_targets already filters those server-side.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin', 'platform'])
        .describe('The channel the run was about to use.'),
      reason: z.enum(['bad_timing', 'no_fresh_material', 'other']),
      note: z.string().min(1).max(2000).optional()
        .describe('One-line context shown in the recent-outreach feed.'),
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
    'Whether the current user\'s Google account is connected (gmail.send scope), and the address it is connected as.',
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
    'Sends an email via the connected Gmail account without recording an outreach log; returns Gmail messageId/threadId. For prospect outreach use send_email_and_record instead.',
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
    'Sends a prospect email and records the outreach log in one call; project outboundMode decides send vs a pending_review draft. Returns outreachId and whether it sent or drafted.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int(),
      to: z.array(z.email()).min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.array(z.email()).optional(),
      bcc: z.array(z.email()).optional(),
      inReplyTo: z.string().optional().describe('RFC 5322 Message-Id of the message being replied to, for threading'),
      variantId: variantIdSchema.optional().describe('Message variant id from pick_message_variant'),
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
    'Batch-delete pending_review drafts by ids, or by projectId to wipe every pending_review draft in the project. Only pending_review rows are deleted; any other status silently excluded. Returns the deleted count and any skipped ids. Preview with list_drafts.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(200).optional()
        .describe('Outreach log ids to discard. Mutually exclusive with projectId.'),
      projectId: z.string().min(1).optional()
        .describe('Project name or ID. Mutually exclusive with ids.'),
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
    'List pending_review drafts for a project, newest first. Returns total and rows with a truncated bodyPreview.',
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
          text: `${total} pending_review draft(s); showing ${rows.length} from offset ${offset}. Full review/edit/send at https://app.leadace.ai/drafts.\n${JSON.stringify(rows, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'update_prospect_status',
    'Update a prospect\'s status within a project. Setting \'new\' is rejected while the prospect has sent outreach in that project.',
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
    'set_prospect_priority',
    'Set one prospect\'s outreach priority (1=highest) within a project. Per-prospect operator override applied regardless of the prospect\'s status; measured targeting outranks priority in the outbound ordering once data accrues. Read the current value via list_project_prospects or get_outbound_targets.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      prospectId: z.number().int().positive(),
      priority: prioritySchema,
    },
    async ({ projectId, prospectId, priority }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi(
        'PATCH',
        `/prospects/${prospectId}/priority`,
        { projectId, priority },
        apiUrl,
        authHeader,
      )
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: `Prospect ${prospectId}: priority = ${priority}.` }] }
    },
  )

  defineTool(
    'update_organization',
    'Partial-update an organization\'s name, website URL, or employeeBand; domain is immutable. organizationId is the PK returned in the organizationId field of list_tenant_prospects / list_project_prospects / get_outbound_targets, not a domain.',
    {
      organizationId: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        employeeBand: z.enum(EMPLOYEE_BANDS).optional(),
      }).describe('At least one required.'),
    },
    async ({ organizationId, patch }, { apiUrl, authHeader }) => {
      if (Object.keys(patch).length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: patch is empty (provide name, websiteUrl, and/or employeeBand).' }], isError: true }
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
    'list_organizations',
    'List tenant organizations with employee-size band and per-org prospect and project counts.',
    {
      q: z.string().optional().describe('Substring search on name / domain'),
      limit: z.number().int().min(1).max(500).default(200),
      offset: z.number().int().min(0).default(0),
    },
    async ({ q, limit, offset }, { apiUrl, authHeader }) => {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      params.set('limit', String(limit))
      params.set('offset', String(offset))

      const { ok, data } = await callApi('GET', `/organizations?${params.toString()}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as {
        organizations: Array<{ id: number; name: string; domain: string; employeeBand: string; prospectCount: number; projectCount: number }>
        total: number
      }
      if (result.organizations.length === 0) {
        return { content: [{ type: 'text' as const, text: `0 of ${result.total} organization(s).` }] }
      }
      const lines = result.organizations.map(
        (o) => `#${o.id} ${o.name} (${o.domain}) size=${o.employeeBand} prospects=${o.prospectCount} projects=${o.projectCount}`,
      )
      return {
        content: [{
          type: 'text' as const,
          text: `${result.organizations.length} of ${result.total} organization(s):\n${lines.join('\n')}`,
        }],
      }
    },
  )

  defineTool(
    'delete_organizations',
    'Permanently delete organizations by id (max 200); organizations that still have prospects are skipped with a reason. Preview with list_organizations.',
    {
      organizationIds: z.array(z.number().int().positive()).min(1).max(200),
    },
    async ({ organizationIds }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/organizations/delete-batch', { organizationIds }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as {
        deleted: number
        deletedIds: number[]
        skipped: Array<{ organizationId: number; reason: string }>
      }
      const parts = [`Deleted ${result.deleted} organization(s).`]
      const byReason = new Map<string, number[]>()
      for (const s of result.skipped) {
        const ids = byReason.get(s.reason) ?? []
        ids.push(s.organizationId)
        byReason.set(s.reason, ids)
      }
      for (const [reason, ids] of byReason) {
        parts.push(`Skipped (${reason}): ${ids.join(', ')}`)
      }
      return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
    },
  )

  defineTool(
    'delete_prospects',
    'Permanently delete prospects by id (max 200), workspace-wide. Do-not-contact prospects, prospects with outreach history, and prospects on 2+ projects are skipped with a reason; reports organizations left with no prospects. Preview with list_project_prospects.',
    {
      prospectIds: z.array(z.number().int().positive()).min(1).max(200),
    },
    async ({ prospectIds }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', '/prospects/delete-batch', { prospectIds }, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as {
        deleted: number
        deletedIds: number[]
        skipped: Array<{ prospectId: number; reason: string }>
        orphanedOrganizationIds: number[]
      }
      const parts = [`Deleted ${result.deleted} prospect(s).`]
      const byReason = new Map<string, number[]>()
      for (const s of result.skipped) {
        const ids = byReason.get(s.reason) ?? []
        ids.push(s.prospectId)
        byReason.set(s.reason, ids)
      }
      for (const [reason, ids] of byReason) {
        parts.push(`Skipped (${reason}): ${ids.join(', ')}`)
      }
      if (result.orphanedOrganizationIds.length > 0) {
        parts.push(`Organizations now left with zero prospects: ${result.orphanedOrganizationIds.join(', ')}`)
      }
      return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
    },
  )

  defineTool(
    'update_prospect',
    'Partial-update a tenant prospect\'s fields. UNPROCESSABLE if the patch would leave no contact channel (email, contactFormUrl, an snsAccounts entry, or platformUrl); CONFLICT if email, contactFormUrl, or platformUrl already belongs to another prospect in the workspace. Changing email resets its deliverability verdict and queues a background re-check. Per-project status via update_prospect_status, priority via set_prospect_priority, DNC via set_prospect_do_not_contact.',
    {
      prospectId: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        contactName: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        overview: z.string().min(1).optional(),
        industry: z.string().nullable().optional().describe('Exact value from the tpl_industries vocabulary (master document), or null to clear; other values are rejected.'),
        websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
        email: z.email().nullable().optional().describe('Setting both email and contactFormUrl to null requires an snsAccounts entry.'),
        contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional(),
        formType: z.enum(['google_forms', 'native_html', 'wordpress_cf7', 'iframe_embed', 'with_captcha']).nullable().optional(),
        snsAccounts: z.object({
          x: z.string().optional(),
          linkedin: z.string().optional(),
          instagram: z.string().optional(),
          facebook: z.string().optional(),
        }).nullable().optional(),
        platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional()
          .describe('External-platform action page answered in-platform via the "platform" channel.'),
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
      }).describe('Omit a key to leave it unchanged; pass null to clear a nullable field.'),
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
    'Set the do_not_contact flag on a tenant prospect. DNC prospects are excluded from re-discovery and outbound targeting.',
    {
      prospectId: z.number().int(),
      doNotContact: z.boolean().describe('false clears an existing flag.'),
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
    'Recent outreach logs for a project. Confirmed events only (sent / failed / skipped) — pending_review drafts and pre_send rows are excluded; use list_drafts for those. Each log carries recipient identifiers (prospectName, contactName, prospectEmail, organizationDomain) and inquiry-landing aggregates (inquirySessionCount, inquiryOutcome, inquiryMeetingSource, inquiryLastVisitAt).',
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
    'Record a response (email reply, SNS DM, etc.) to an outreach; updates prospect status and marks do-not-contact. do_not_contact is forced on responseType=bounce, on rejectionFeedback opt-out reasons, and when the per-project rejection cycle cap (maxReapproachCycles) is reached — the cap also drops the recontact window so a would-be deferred becomes rejected. rejectionFeedback with wrong_timing/budget plus a recontact window sets status=deferred (next_outreach_after); a decision_maker_pointer auto-creates or updates a prospect, reported back as derived prospects.',
    {
      outreachLogId: z.number().int().describe('ID of the outreach log this response is for'),
      channel: z.enum(['email', 'form', 'sns_twitter', 'sns_linkedin', 'platform']),
      content: z.string().describe('Response content'),
      sentiment: z.enum(['positive', 'neutral', 'negative']),
      responseType: z.enum(['reply', 'auto_reply', 'bounce', 'meeting_request', 'rejection']),
      receivedAt: z.string().datetime().optional(),
      markDoNotContact: z.boolean().default(false).describe('Manual do_not_contact flag; bounces and rejectionFeedback opt-outs force it regardless.'),
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
      }).optional().describe('Only valid when responseType="rejection".'),
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
    'Aggregate rejection_feedback for a project. Returns primaryReasonDistribution, the tactical fields recontactWindows / decisionMakerPointers / notRelevantNotes / budgetNotes (budget free-text), and the pmf field feature_gap free-text notes. Read-only view — any deferral or prospect creation these rows imply happened at record_response time, not on read.',
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
    'Evaluation statistics for a project: response rates, channel performance, sentiment breakdown, discoveryStrategyResponseRate (per discovery strategy; the null bucket is prospects without recorded provenance), targeting observation axes (industryResponseRate by coarse bucket / sizeResponseRate by employee band / countryResponseRate — these three count mature sends only, older than the reply-maturity window), freshSignalResponseRate, inquiry-landing outcome counts, respondedMessages, and a data-sufficiency check. Reply rates exclude bounces/auto-replies; per-bucket bounces + bounceRate are a threaded-only lower bound.',
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
    'record_suggestion',
    'Persist an actionable suggestion for the user (surfaced in the Web UI dashboard). Reserve for actions only the user can perform. Upserts by kind + dedupeKey: refreshes an open suggestion, never resurrects a dismissed/done one — the confirmation reports id, status, and whether it was written or left untouched.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      kind: suggestionKindSchema.describe('Suggestion kind, lowercase kebab-case category'),
      dedupeKey: z.string().min(1).describe('Stable dedup key within the kind'),
      title: z.string().min(1).describe('Short headline shown in the Web UI'),
      body: z.string().min(1).describe('Rationale and expected payoff, markdown'),
      command: z.string().min(1).describe('Copy-runnable next action, e.g. a /leadace one-liner'),
    },
    async ({ projectId, ...body }, { apiUrl, authHeader }) => {
      const { ok, data } = await callApi('POST', `/projects/${encodeURIComponent(projectId)}/suggestions`, body, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { id: number; status: string; written: boolean }
      const text = result.written
        ? `Suggestion recorded (id ${result.id}, status ${result.status}).`
        : `Suggestion left untouched — an existing one (id ${result.id}) is ${result.status}; the user's status decision stands. Do not re-propose it.`
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  defineTool(
    'list_suggestions',
    'List persisted suggestions for a project: id, kind, dedupeKey, title, body, command, status (open/dismissed/done), timestamps. Optional status filter.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      status: z.enum(SUGGESTION_STATUSES).optional().describe('Filter by status'),
    },
    async ({ projectId, status }, { apiUrl, authHeader }) => {
      const qs = status ? `?status=${status}` : ''
      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/suggestions${qs}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
  )

  defineTool(
    'get_document',
    'Get the latest version of a project document by slug. For sales_strategy, a WARNING line is appended while the Prospect Discovery Sources section still needs the named-strategy upgrade.',
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
      const doc = data as { id: number; slug: string; content: string; createdAt: string; discoverySourcesFormat?: string }
      const warning = discoveryUpgradeWarning(doc.discoverySourcesFormat)
      // The warning rides in its own block so the document body stays
      // copy/paste-safe for save_document round-trips.
      const blocks = [{ type: 'text' as const, text: doc.content }]
      if (warning) blocks.push({ type: 'text' as const, text: warning })
      return { content: blocks }
    },
  )

  defineTool(
    'save_document',
    'Save a project document by slug as a new immutable version; prior versions preserved. For sales_strategy, the confirmation carries a WARNING while Prospect Discovery Sources still needs the named-strategy upgrade.',
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
      const result = data as { id: number; slug: string; createdAt: string; discoverySourcesFormat?: string }
      const warning = discoveryUpgradeWarning(result.discoverySourcesFormat)
      const saved = `Document "${slug}" saved (version id: ${result.id}).`
      return { content: [{ type: 'text' as const, text: warning ? `${saved}\n${warning}` : saved }] }
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
    'Get a shared master document by slug.',
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
    'List existing prospects across the entire tenant, excluding do-not-contact prospects. No pagination — results beyond `limit` are truncated.',
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
    'list_project_prospects',
    'List a project\'s prospects with per-project status, priority, and matchReason. Unlike get_outbound_targets (reachable rows only), lists prospects in any status. Sorted by priority ascending, newest first within a rank.',
    {
      projectId: z.string().min(1).describe('Project name or ID'),
      status: z.enum(prospectStatusEnum.enumValues).optional().describe('Filter by per-project status'),
      priority: prioritySchema.optional().describe('Filter by exact priority'),
      q: z.string().min(1).optional().describe('Substring search on prospect name / contact name / organization name / domain'),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    },
    async ({ projectId, status, priority, q, limit, offset }, { apiUrl, authHeader }) => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (priority !== undefined) params.set('priority', String(priority))
      if (q) params.set('q', q)
      params.set('limit', String(limit))
      params.set('offset', String(offset))

      const { ok, data } = await callApi('GET', `/projects/${encodeURIComponent(projectId)}/prospects?${params.toString()}`, null, apiUrl, authHeader)
      if (!ok) {
        const err = data as { error: string }
        return { content: [{ type: 'text' as const, text: `Error: ${err.error}` }], isError: true }
      }
      const result = data as { prospects: unknown[]; total: number }
      return {
        content: [{
          type: 'text' as const,
          text: `${result.total} prospect(s) match; showing ${result.prospects.length} (offset ${offset}).\n${JSON.stringify(result.prospects, null, 2)}`,
        }],
      }
    },
  )

  defineTool(
    'link_existing_prospects_to_project',
    'Link existing tenant prospects to a project; does NOT create new prospects or organizations. Skips prospects that are do_not_contact or not found in this tenant (per-prospect reason in skippedDetails); returns linked / alreadyLinked / skipped counts.',
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
    'Get user-editable project settings as JSON (outboundMode, sender identity, unsubscribeEnabled, footerOverride, inquiry-landing config, follow-up/recycle windows, outboundChannels, targetCountries, targetLanguage). Fields the user never set carry their column defaults; 404 when the project does not exist.',
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
        .describe('"send" sends immediately; "draft" stores as reviewable LeadAce drafts instead of sending.'),
      senderEmailAlias: z.email().nullable().optional()
        .describe('Gmail Send-As alias to use as From: address. null = primary Gmail.'),
      senderDisplayName: z.string().min(1).max(200).nullable().optional()
        .describe('Personal name shown as the email From: display name and on the inquiry-landing header.'),
      senderCompanyName: z.string().min(1).max(200).nullable().optional()
        .describe('Company / brand name shown to recipients on the inquiry landing. Distinct from the compliance-footer legal name and the internal workspace name. null omits it.'),
      senderJobTitle: z.string().min(1).max(200).nullable().optional()
        .describe('Job title / role shown alongside senderDisplayName on the inquiry-landing header. No-op when senderDisplayName is null.'),
      unsubscribeEnabled: z.boolean().optional()
        .describe('Attach the RFC 8058 List-Unsubscribe one-click headers to outbound email.'),
      footerOverride: z.string().trim().min(1).max(2000).nullable().optional()
        .describe('Custom footer replacing the default compliance footer VERBATIM on every outbound message (email, and form / SNS draft text) — when set, it must itself carry the "---" separator and the legally required disclosures. null restores the default. Mutually exclusive with inquiryLandingEnabled (400).'),
      inquiryLandingEnabled: z.boolean().optional()
        .describe('When true, outbound emails include an inquiry-landing URL footer that hosts a per-recipient AI chat, meeting-request button, and unsubscribe-with-reason flow.'),
      inquiryChatBrief: z.string().max(4000).nullable().optional()
        .describe('Briefing for the inquiry-landing chat agent. null disables chat input but keeps the rest of the landing page rendering.'),
      inquiryOneLiner: z.string().max(140).nullable().optional()
        .describe('Single-sentence value prop shown above the chat input on the landing page.'),
      inquiryVideoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('YouTube/Vimeo unlisted video URL embedded on the landing page. https:// only.'),
      inquiryPdfUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('Public URL for the "download PDF" button on the landing page. https:// only.'),
      inquiryBrandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional()
        .describe('Landing-page accent color.'),
      inquiryBrandLogoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('Public URL for the brand logo shown on the landing page. https:// only.'),
      inquiryDarkBackground: z.boolean().optional()
        .describe('Landing background mode: false = light (default), true = dark.'),
      inquiryCtaType: z.enum(['meeting', 'signup']).optional()
        .describe('Landing CTA mode. "meeting" (default): Book/Request meeting button, inquiryCtaUrl optional (scheduling URL). "signup": Sign up button redirecting to inquiryCtaUrl, which is required in this mode.'),
      inquiryCtaUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional()
        .describe('CTA URL, https:// only. For inquiryCtaType="meeting": optional scheduling URL — when null the meeting button is notify-only. For inquiryCtaType="signup": the signup page URL, required.'),
      maxReapproachCycles: z.coerce.number().int().min(1).max(10).optional()
        .describe('Hard cap on rejection cycles before forcing rejected + DNC. Default 3.'),
      unspecifiedRecontactWindowMonths: z.coerce.number().int().min(1).max(24).optional()
        .describe('Months to defer when rejection feedback preferred_recontact_window is "unspecified". Default 3.'),
      noResponseRecycleDays: z.coerce.number().int().min(7).max(365).optional()
        .describe('Days after a sent outreach before the prospect is re-eligible if no response arrived. Default 90. Only advances the re-eligibility window forward, never shortens a longer existing deferral (e.g. a rejection-feedback 12-month window).'),
      followUpSequence: z.object({
        enabled: z.boolean().optional(),
        gapDays: z.array(z.coerce.number().int().min(1).max(90)).min(1).max(5).optional(),
      }).optional()
        .describe('Follow-up sequence for unanswered prospects. gapDays = relative waits in DAYS before each next touch (default [3,7,7]). Whole-object replace: omitting `enabled` sets it false, disabling follow-ups AND clearing in-progress sequences — pass enabled:true explicitly to keep them on while changing cadence.'),
      outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).optional()
        .describe('Channels the project is allowed to use for outbound. Default: email, form, sns_twitter, sns_linkedin — "platform" must be enabled explicitly. Empty array pauses automated outbound (manual per-draft send still works).'),
      targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).optional()
        .describe('Country codes that further narrow the compliance-level send allowlist. Empty array (default) = no project-level restriction; non-empty = explicit allowlist.'),
      targetLanguage: localeSchema.optional()
        .describe('Language of this project\'s outbound messages (default "en"): sets the compliance-footer / identity localization and the language outbound subjects and bodies are written in. Independent of targetCountries; recipient-facing web pages (inquiry landing, unsubscribe) follow the visitor\'s browser language instead.'),
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

// Lazy so requests that never touch the catalog (OAuth flow, /.well-known/*)
// don't pay the build cost on a cold isolate.
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
