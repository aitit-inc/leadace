import { z } from 'zod'
import { eq, and, sql, inArray, not, isNull, or, ne, notExists } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  organizations,
  prospects,
  projectProspects,
  discoveryCharges,
  formTypeEnum,
  prioritySchema,
  EMPLOYEE_BANDS,
  type SnsAccounts,
  type ProspectHypothesis,
  type CountrySource,
  type EmployeeBand,
  type ProspectOrigin,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  discoveryStrategySchema,
  projectRefSchema,
  type ProjectId,
  type ProjectRef,
  type TenantId,
} from '../domain/ids'
import {
  getTenantPlan,
  getPlanLimits,
  getRemainingProspectQuotaForPlan,
  discoveryPausedReason,
  countTenantProspects,
} from './plan-limits'
import { ok, err, type ServiceResult } from './result'
import { debitFound } from './credits'
import { nextFoundRegistration, type FoundRegistration } from '../domain/credits'
import { resolveProject } from './projects'
import { hasContactExpr } from './prospects'
import { loadProjectOutboundAllowlist } from './project-settings'
import { contactDecision, type OutboundChannel } from '../domain/outbound-channel'
import { listDiscoveryStrategiesById } from './discovery-strategies'
import { parseCsv } from '../domain/csv'
import type { Edition } from '../domain/edition'
import { projectProspectInsertValues } from '../domain/project-prospect'
import { inferCountryFromDomain } from '../domain/country'
import { normalizeDomain } from '../domain/normalize-domain'
import { isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG } from '../domain/url'
import {
  resolveDedup,
  claimRow,
  overwriteSourceToSkipReason,
  type DedupIndex,
  type DedupSkipReason,
} from '../domain/prospect-dedup'
import { isKnownIndustry } from '../domain/coarse-industry'
import { siteReadPatch } from '../domain/site-read'

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

const snsAccountsSchema = z.object({
  x: z.string().optional(),
  linkedin: z.string().optional(),
  instagram: z.string().optional(),
  facebook: z.string().optional(),
})

// Mirrors ProspectHypothesis in db/schema.ts; a partial hypothesis still
// informs /outbound and the inquiry chat snapshot.
const hypothesisSchema = z.object({
  targetDepartment: z.string().optional(),
  targetRolePattern: z.string().optional(),
  hypothesizedPain: z.array(z.string()).max(10).optional(),
  valueMapping: z.array(z.string()).max(10).optional(),
  timingSignals: z.array(z.string()).max(10).optional(),
  bestChannel: z.string().optional(),
  bestKeyperson: z.string().optional(),
})

const prospectInputSchema = z.object({
  organizationDomain: z.string().min(1).transform(normalizeDomain),
  organizationName: z.string().min(1),
  organizationWebsiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
  // Caller may NOT claim 'tld_inferred' as the source; only the server
  // writes that on bootstrap.
  country: z.string().regex(COUNTRY_CODE_REGEX).optional(),
  countrySource: z.enum(['manual', 'ai_inferred']).optional(),
  employeeBand: z.enum(EMPLOYEE_BANDS).optional(),
  name: z.string().min(1),
  contactName: z.string().optional(),
  department: z.string().optional(),
  overview: z.string().min(1),
  industry: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
  email: z.email().optional(),
  emailSourceUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  emailNoSolicitation: z.boolean().optional(),
  contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  formType: z.enum(formTypeEnum.enumValues).optional(),
  formNoSolicitation: z.boolean().optional(),
  snsAccounts: snsAccountsSchema.optional(),
  platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  notes: z.string().optional(),
  hypothesis: hypothesisSchema.optional(),
  // One-way ratchet on import: true sets/keeps DNC; false (or omitted) never clears.
  doNotContact: z.boolean().optional(),
  // Only consulted when projectId is set on the request.
  matchReason: z.string().min(1).optional(),
  priority: prioritySchema.default(3),
  // Write-once provenance; CSV import deliberately has no header for it.
  discoveryStrategy: discoveryStrategySchema.optional(),
}).refine(
  (p) => p.email || p.contactFormUrl || p.platformUrl || (p.snsAccounts && Object.values(p.snsAccounts).some(Boolean)),
  { message: 'At least one contact channel (email, contactFormUrl, snsAccounts, or platformUrl) is required' },
).refine(
  (p) => !p.emailSourceUrl || p.email,
  { message: 'emailSourceUrl describes the stored email address, so it requires email' },
).refine(
  (p) => !p.emailNoSolicitation || p.email,
  { message: 'emailNoSolicitation describes the stored email address, so it requires email' },
).refine(
  (p) => !p.formNoSolicitation || p.contactFormUrl,
  { message: 'formNoSolicitation describes the stored contact form, so it requires contactFormUrl' },
)
type ProspectInput = z.infer<typeof prospectInputSchema>

export const batchSchema = z.object({
  projectId: projectRefSchema.optional(),
  prospects: z.array(prospectInputSchema).min(1).max(100),
})
export type BatchInput = z.infer<typeof batchSchema>

export const importSchema = z.object({
  projectId: projectRefSchema.optional(),
  csvText: z.string().min(1),
  dedupPolicy: z.enum(['skip', 'overwrite']).default('skip'),
})
export type ImportInput = z.infer<typeof importSchema>

// Pre-flight subset of prospectInputSchema — only keys available before
// paying for contact retrieval.
const dedupCandidateSchema = z.object({
  organizationDomain: z.string().min(1).transform(normalizeDomain),
  email: z.email().optional(),
  contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
})

export const checkDedupSchema = z.object({
  projectId: projectRefSchema.optional(),
  candidates: z.array(dedupCandidateSchema).min(1).max(100),
})
export type CheckDedupInput = z.infer<typeof checkDedupSchema>

const REQUIRED_CSV_HEADERS = [
  'organizationDomain',
  'organizationName',
  'organizationWebsiteUrl',
  'name',
  'overview',
  'websiteUrl',
] as const

const ALLOWED_CSV_HEADERS = new Set<string>([
  ...REQUIRED_CSV_HEADERS,
  'matchReason',
  'contactName',
  'department',
  'industry',
  'email',
  'emailNoSolicitation',
  'contactFormUrl',
  'formNoSolicitation',
  'formType',
  'snsAccounts.x',
  'snsAccounts.linkedin',
  'snsAccounts.instagram',
  'snsAccounts.facebook',
  'platformUrl',
  'notes',
  'priority',
  'doNotContact',
  'country',
  'countrySource',
])

export function validateCsvHeader(
  header: string[],
  requireMatchReason: boolean,
): { ok: true } | { ok: false; error: string; detail: string } {
  const missing = REQUIRED_CSV_HEADERS.filter((h) => !header.includes(h))
  if (missing.length > 0) {
    return { ok: false, error: 'Missing required columns', detail: missing.join(', ') }
  }
  if (requireMatchReason && !header.includes('matchReason')) {
    return {
      ok: false,
      error: 'Missing required columns',
      detail: 'matchReason is required when projectId is provided',
    }
  }
  const unknown = header.filter((h) => !ALLOWED_CSV_HEADERS.has(h))
  if (unknown.length > 0) {
    return { ok: false, error: 'Unknown columns', detail: unknown.join(', ') }
  }
  return { ok: true }
}

const CSV_BOOLEAN_HEADERS = new Set(['doNotContact', 'emailNoSolicitation', 'formNoSolicitation'])
const CSV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const CSV_FALSY = new Set(['0', 'false', 'no', 'off'])

const MAX_IMPORT_ROWS = 1000

export function csvRowToInput(header: string[], row: string[]): { ok: true; value: ProspectInput } | { ok: false; error: string } {
  const obj: Record<string, unknown> = {}
  const sns: Record<string, string> = {}
  for (let j = 0; j < header.length; j++) {
    const key = header[j]
    if (!key) continue
    const raw = row[j] ?? ''
    const val = raw.trim()
    if (val === '') continue
    if (key.startsWith('snsAccounts.')) {
      sns[key.slice('snsAccounts.'.length)] = val
    } else if (key === 'priority') {
      const n = Number.parseInt(val, 10)
      if (!Number.isFinite(n)) return { ok: false, error: 'priority: not an integer' }
      obj.priority = n
    } else if (CSV_BOOLEAN_HEADERS.has(key)) {
      const lower = val.toLowerCase()
      if (CSV_TRUTHY.has(lower)) obj[key] = true
      else if (CSV_FALSY.has(lower)) obj[key] = false
      else return { ok: false, error: `${key}: not a boolean (got "${val}")` }
    } else {
      obj[key] = val
    }
  }
  if (Object.keys(sns).length > 0) obj.snsAccounts = sns

  const parsed = prospectInputSchema.safeParse(obj)
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
      .join('; ')
    return { ok: false, error: msg }
  }
  return { ok: true, value: parsed.data }
}

// Absent keys preserve the existing prospect.country on the overwrite path.
// Org country is the primary signal; prospect.country is for "person located
// in a different country than their employer".
function prospectCountryPatch(input: ProspectInput): {
  country?: string
  countrySource?: CountrySource
} {
  if (!input.country) return {}
  return {
    country: input.country.toUpperCase(),
    countrySource: input.countrySource ?? 'manual',
  }
}

// emailDeliverability is left to its column default ('unknown'); the verdict is
// resolved off the request path and stamped by stampEmailDeliverability.
function prospectInsertValues(
  tenantId: TenantId,
  input: ProspectInput,
  orgId: number,
  now: Date,
  origin: ProspectOrigin,
) {
  return {
    tenantId,
    origin,
    name: input.name,
    contactName: input.contactName ?? null,
    organizationId: orgId,
    department: input.department ?? null,
    overview: input.overview,
    industry: input.industry ?? null,
    websiteUrl: input.websiteUrl,
    email: input.email ?? null,
    emailSourceUrl: input.emailSourceUrl ?? null,
    emailNoSolicitation: input.emailNoSolicitation ?? false,
    contactFormUrl: input.contactFormUrl ?? null,
    formType: input.formType ?? null,
    formNoSolicitation: input.formNoSolicitation ?? false,
    snsAccounts: (input.snsAccounts as SnsAccounts) ?? null,
    platformUrl: input.platformUrl ?? null,
    notes: input.notes ?? null,
    hypothesis: (input.hypothesis as ProspectHypothesis) ?? null,
    ...siteReadPatch(input.hypothesis, now),
    ...prospectCountryPatch(input),
    discoveryStrategy: input.discoveryStrategy ?? null,
    doNotContact: input.doNotContact ?? false,
    createdAt: now,
    updatedAt: now,
  }
}

// Overwrite touches only caller-supplied columns — a sparse CSV row that
// omits `notes` must not NULL existing notes.
function prospectUpdateSet(input: ProspectInput, orgId: number, now: Date) {
  return {
    name: input.name,
    organizationId: orgId,
    overview: input.overview,
    websiteUrl: input.websiteUrl,
    ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.department !== undefined ? { department: input.department } : {}),
    ...(input.industry !== undefined ? { industry: input.industry } : {}),
    // Reset the verdict only when the stored email actually changes — evaluated
    // in-SQL against the current row (no extra read), so an overwrite carrying the
    // same address keeps any prior 'undeliverable' verdict instead of briefly
    // re-opening it. The background stamp re-resolves it when it did change.
    ...(input.email !== undefined
      ? {
          email: input.email,
          emailDeliverability: sql`CASE WHEN ${prospects.email} IS DISTINCT FROM ${input.email} THEN 'unknown'::email_deliverability ELSE ${prospects.emailDeliverability} END`,
          mailboxVerifiedAt: sql`CASE WHEN ${prospects.email} IS DISTINCT FROM ${input.email} THEN NULL ELSE ${prospects.mailboxVerifiedAt} END`,
          // Provenance describes the stored address, so a changed address
          // without a new source URL leaves no record rather than a stale one.
          ...(input.emailSourceUrl === undefined
            ? { emailSourceUrl: sql`CASE WHEN ${prospects.email} IS DISTINCT FROM ${input.email} THEN NULL ELSE ${prospects.emailSourceUrl} END` }
            : {}),
          // A recorded notice ratchets like doNotContact, but only while the
          // address it describes is unchanged.
          emailNoSolicitation: sql`CASE WHEN ${prospects.email} IS DISTINCT FROM ${input.email} THEN ${input.emailNoSolicitation ?? false} ELSE (${prospects.emailNoSolicitation} OR ${input.emailNoSolicitation ?? false}) END`,
        }
      : {}),
    ...(input.emailSourceUrl !== undefined ? { emailSourceUrl: input.emailSourceUrl } : {}),
    ...(input.contactFormUrl !== undefined
      ? {
          contactFormUrl: input.contactFormUrl,
          formNoSolicitation: sql`CASE WHEN ${prospects.contactFormUrl} IS DISTINCT FROM ${input.contactFormUrl} THEN ${input.formNoSolicitation ?? false} ELSE (${prospects.formNoSolicitation} OR ${input.formNoSolicitation ?? false}) END`,
        }
      : {}),
    ...(input.formType !== undefined ? { formType: input.formType } : {}),
    ...(input.snsAccounts !== undefined ? { snsAccounts: input.snsAccounts as SnsAccounts } : {}),
    ...(input.platformUrl !== undefined ? { platformUrl: input.platformUrl } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis as ProspectHypothesis } : {}),
    ...siteReadPatch(input.hypothesis, now),
    ...prospectCountryPatch(input),
    // One-way DNC ratchet: only set true; imports never clear an existing flag.
    ...(input.doNotContact === true ? { doNotContact: true } : {}),
    updatedAt: now,
  }
}

async function buildDedupIndex(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  inputs: ReadonlyArray<Pick<ProspectInput, 'email' | 'contactFormUrl' | 'platformUrl' | 'organizationDomain'>>,
): Promise<DedupIndex> {
  const emails = Array.from(
    new Set(inputs.map((i) => i.email).filter((v): v is string => Boolean(v))),
  )
  const forms = Array.from(
    new Set(inputs.map((i) => i.contactFormUrl).filter((v): v is string => Boolean(v))),
  )
  const platforms = Array.from(
    new Set(inputs.map((i) => i.platformUrl).filter((v): v is string => Boolean(v))),
  )
  const domains = Array.from(
    new Set(inputs.map((i) => i.organizationDomain).filter((v): v is string => Boolean(v))),
  )

  const [byEmailRows, byFormRows, byPlatformRows, dncDomainRows, domainRows] = await Promise.all([
    emails.length > 0
      ? db
          .select({
            id: prospects.id,
            email: prospects.email,
            doNotContact: prospects.doNotContact,
          })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tenantId), inArray(prospects.email, emails)))
      : Promise.resolve([]),
    forms.length > 0
      ? db
          .select({ id: prospects.id, contactFormUrl: prospects.contactFormUrl })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tenantId), inArray(prospects.contactFormUrl, forms)))
      : Promise.resolve([]),
    platforms.length > 0
      ? db
          .select({ id: prospects.id, platformUrl: prospects.platformUrl })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tenantId), inArray(prospects.platformUrl, platforms)))
      : Promise.resolve([]),
    domains.length > 0
      ? db
          .select({ domain: organizations.domain })
          .from(organizations)
          .where(and(
            eq(organizations.tenantId, tenantId),
            inArray(organizations.domain, domains),
            eq(organizations.doNotContact, true),
          ))
      : Promise.resolve([]),
    projectId && domains.length > 0
      ? db
          .select({ domain: organizations.domain })
          .from(projectProspects)
          .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
          .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
          .where(and(
            eq(projectProspects.tenantId, tenantId),
            eq(projectProspects.projectId, projectId),
            inArray(organizations.domain, domains),
          ))
      : Promise.resolve([]),
  ])

  const byEmail = new Map<string, { id: number; doNotContact: boolean }>()
  for (const r of byEmailRows) {
    if (r.email) byEmail.set(r.email, { id: r.id, doNotContact: r.doNotContact })
  }
  const byForm = new Map<string, { id: number }>()
  for (const r of byFormRows) {
    if (r.contactFormUrl) byForm.set(r.contactFormUrl, { id: r.id })
  }
  const byPlatform = new Map<string, { id: number }>()
  for (const r of byPlatformRows) {
    if (r.platformUrl) byPlatform.set(r.platformUrl, { id: r.id })
  }
  const dncDomains = new Set<string>(dncDomainRows.map((r) => r.domain))
  const domainsInProject = new Set<string>(domainRows.map((r) => r.domain))

  return {
    byEmail,
    byForm,
    byPlatform,
    dncDomains,
    domainsInProject,
    claimedEmails: new Set(),
    claimedForms: new Set(),
    claimedPlatforms: new Set(),
    claimedDomains: new Set(),
  }
}

type BatchSkipped = {
  name: string
  reason: 'plan_limit' | 'unknown_industry' | 'unknown_strategy' | DedupSkipReason
  detail?: string
}

function unknownIndustryDetail(industry: string | undefined): string | null {
  if (industry === undefined || isKnownIndustry(industry)) return null
  return `industry "${industry}" is not in the tpl_industries vocabulary; use an exact value from that document (or omit)`
}

export type BatchRegisterResult = {
  registered: Array<{ id: number; name: string }>
  skippedDetails: BatchSkipped[]
  // Emails for the caller to resolve via the background deliverability stamp.
  emailsToVerify: string[]
}

// Only a billable candidate (reachable on the project's channels, past the
// Prerequisite check) spends the found allowance.
export type FoundVerdict = 'billable' | 'unreachable' | 'unqualified'

// The found allowance left this period, read once under the tenant lock:
// 'paused' when none may be spent, null when it is unlimited.
type FoundBudget = { freeSlots: number; balanceCents: number | null } | 'paused' | null

async function readFoundBudget(db: Db, tenantId: TenantId, tp: Awaited<ReturnType<typeof getTenantPlan>>): Promise<FoundBudget> {
  const quota = await getRemainingProspectQuotaForPlan(db, tenantId, tp)
  if (quota.kind !== 'capped') return null
  if (discoveryPausedReason(quota)) return 'paused'
  return { freeSlots: quota.found.remaining, balanceCents: quota.credits?.balanceCents ?? null }
}

function nextFound(budget: FoundBudget): FoundRegistration {
  if (budget === null) return { charge: false }
  return budget === 'paused' ? null : nextFoundRegistration(budget.freeSlots, budget.balanceCents)
}

async function spendFound(db: Db, tenantId: TenantId, prospectId: number, budget: FoundBudget, registration: NonNullable<FoundRegistration>, now: Date): Promise<void> {
  await db.insert(discoveryCharges).values({ tenantId, prospectId, createdAt: now })
  if (budget === null || budget === 'paused') return
  if (registration.charge) {
    await debitFound(db, tenantId, prospectId)
    budget.balanceCents = registration.balanceAfterCents
  } else {
    budget.freeSlots -= 1
  }
}

// The registering path's own claim, never the request body's: the hosted
// discovery pipeline registers 'found', every API caller 'brought_in'.
export type Registration = { origin: 'brought_in' } | { origin: 'found'; verdict: FoundVerdict }

export async function batchRegister(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: BatchInput,
  path: Registration,
): Promise<ServiceResult<BatchRegisterResult>> {
  const { projectId: projectRef, prospects: inputs } = input
  const billable = path.origin === 'found' && path.verdict === 'billable'

  const [resolved, tp] = await Promise.all([
    projectRef ? resolveProject(db, tenantId, projectRef) : Promise.resolve(null),
    getTenantPlan(db, tenantId, edition),
  ])
  if (resolved && !resolved.ok) return resolved
  const projectId = resolved?.value

  if (projectId) {
    const missingReason = inputs.find((p) => !p.matchReason || p.matchReason.trim() === '')
    if (missingReason) {
      return err(
        'INVALID_INPUT',
        'matchReason is required for every prospect when projectId is provided',
        `First offending row: ${missingReason.name}`,
      )
    }
  }

  const carriesStrategy = inputs.some((p) => Boolean(p.discoveryStrategy))
  if (carriesStrategy && !projectId) {
    return err(
      'INVALID_INPUT',
      'discoveryStrategy requires projectId',
      'Discovery strategies are project assets; omit discoveryStrategy when registering without a project.',
    )
  }
  // Archived slugs stay valid provenance (the tick may archive one mid-batch);
  // only an unregistered slug — a phantom attribution arm — skips its row.
  const registeredSlugs = carriesStrategy && projectId
    ? new Set((await listDiscoveryStrategiesById(db, projectId)).map((s) => s.slug))
    : new Set<string>()

  const limits = getPlanLimits(tp.plan)

  let prospectBudget: number | null = null
  if (limits.maxProspects !== null) {
    const currentCount = await countTenantProspects(db, tenantId)
    prospectBudget = Math.max(0, limits.maxProspects - currentCount)
    if (prospectBudget === 0) {
      return err(
        'FORBIDDEN',
        'Prospect registration limit reached',
        `Your ${tp.plan} plan allows ${limits.maxProspects} prospects. Upgrade your plan to register more.`,
        {
          inserted: 0,
          skipped: inputs.length,
          insertedIds: [],
          skippedDetails: inputs.map((i) => ({ name: i.name, reason: 'plan_limit' as const })),
          emailsToVerify: [],
        },
      )
    }
  }
  // The found allowance is the discovery cost guard: rows past it are skipped,
  // not refused, so a pipeline run that crosses it mid-batch still completes.
  // The tenant-level lock serializes concurrent discovery batches (two
  // projects' jobs) on the budget read, so they cannot both spend the last slot,
  // and on the dedup read, which no unique key backs for a contactless record.
  // Past the free slots each row debits credits while the balance covers it
  // (domain/credits.ts nextFoundRegistration); the caller tops up afterwards.
  if (path.origin === 'found') await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`)
  const foundBudget = billable ? await readFoundBudget(db, tenantId, tp) : null

  const dedup = await buildDedupIndex(db, tenantId, projectId, inputs)

  const registered: BatchRegisterResult['registered'] = []
  const skipped: BatchSkipped[] = []
  const emailsToVerify: string[] = []

  for (const input of inputs) {
    if (prospectBudget !== null && registered.length >= prospectBudget) {
      skipped.push({ name: input.name, reason: 'plan_limit' })
      continue
    }
    const registration = nextFound(foundBudget)
    if (!registration) {
      skipped.push({ name: input.name, reason: 'plan_limit' })
      continue
    }

    const resolution = resolveDedup(dedup, projectId, input)
    if (resolution.kind === 'skip') {
      skipped.push({ name: input.name, reason: resolution.reason })
      continue
    }
    // batchRegister never overwrites; that's importCsv's dedupPolicy='overwrite'.
    if (resolution.kind === 'overwrite') {
      skipped.push({ name: input.name, reason: overwriteSourceToSkipReason(resolution.source) })
      continue
    }

    const industryProblem = unknownIndustryDetail(input.industry)
    if (industryProblem) {
      skipped.push({ name: input.name, reason: 'unknown_industry', detail: industryProblem })
      continue
    }

    if (input.discoveryStrategy && !registeredSlugs.has(input.discoveryStrategy)) {
      skipped.push({
        name: input.name,
        reason: 'unknown_strategy',
        detail: `discovery strategy "${input.discoveryStrategy}" is not registered on this project; register it via upsert_discovery_strategy or omit the field`,
      })
      continue
    }

    const now = new Date()
    const org = await upsertOrganization(db, tenantId, input, now)
    if (!org) continue

    const [newProspect] = await db
      .insert(prospects)
      .values(prospectInsertValues(tenantId, input, org.id, now, path.origin))
      .returning({ id: prospects.id })
    if (!newProspect) continue

    if (billable) await spendFound(db, tenantId, newProspect.id, foundBudget, registration, now)

    if (projectId) {
      await db.insert(projectProspects).values({
        ...projectProspectInsertValues({
          tenantId,
          projectId,
          prospectId: newProspect.id,
          matchReason: input.matchReason!,
          priority: input.priority,
          now,
        }),
        qualified: path.origin === 'brought_in' || path.verdict !== 'unqualified',
      })
    }

    claimRow(dedup, projectId, input)
    registered.push({ id: newProspect.id, name: input.name })
    if (input.email && !input.emailNoSolicitation) emailsToVerify.push(input.email)
  }

  return ok({ registered, skippedDetails: skipped, emailsToVerify })
}

export type Rejudged = { prospectId: number; input: ProspectInput; verdict: FoundVerdict }

type OnFile = { email: string | null; emailNoSolicitation: boolean; form: string | null; formNoSolicitation: boolean; sns: SnsAccounts | null }

function reachableOnFile(p: OnFile, channels: readonly OutboundChannel[]): boolean {
  const state = (value: string | null, refused: boolean) => (value === null ? null : refused ? 'refused' as const : 'usable' as const)
  const found = { email: state(p.email, p.emailNoSolicitation), form: state(p.form, p.formNoSolicitation), x: Boolean(p.sns?.x), linkedin: Boolean(p.sns?.linkedin) }
  return contactDecision(found, channels) === 'reachable'
}

// A listed prospect judged again on a page not read for it (#1081); which ones,
// prospectToRejudge decides, checked again here on locked rows. A fit fills in
// contacts where none is on file and becomes a target. What is on file after
// the write decides the charge: a found prospect reachable for the first time
// spends the found allowance as a new one does.
export async function applyRejudged(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  projectId: ProjectId,
  rows: Rejudged[],
): Promise<ServiceResult<{ skipped: Map<number, 'plan_limit' | DedupSkipReason>; emailsToVerify: string[] }>> {
  const ids = rows.map((r) => r.prospectId)
  const emails = rows.flatMap((r) => (r.input.email ? [r.input.email] : []))
  const forms = rows.flatMap((r) => (r.input.contactFormUrl ? [r.input.contactFormUrl] : []))
  const otherPp = alias(projectProspects, 'other_pp')
  const otherP = alias(prospects, 'other_p')
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`)
  const [open, takenEmails, takenForms, charged, budget, allowlist] = await Promise.all([
    db
      .select({
        id: prospects.id,
        organizationId: prospects.organizationId,
        origin: prospects.origin,
        email: prospects.email,
        emailNoSolicitation: prospects.emailNoSolicitation,
        form: prospects.contactFormUrl,
        formNoSolicitation: prospects.formNoSolicitation,
        sns: prospects.snsAccounts,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(and(
        eq(projectProspects.tenantId, tenantId),
        eq(projectProspects.projectId, projectId),
        inArray(projectProspects.prospectId, ids),
        eq(projectProspects.status, 'new'),
        eq(prospects.doNotContact, false),
        eq(organizations.doNotContact, false),
        isNull(prospects.email),
        or(eq(projectProspects.qualified, true), not(hasContactExpr)),
        notExists(db
          .select({ id: otherP.id })
          .from(otherPp)
          .innerJoin(otherP, eq(otherP.id, otherPp.prospectId))
          .where(and(eq(otherPp.projectId, projectId), eq(otherP.organizationId, prospects.organizationId), ne(otherP.id, prospects.id)))),
      ))
      // The person's own edits take no tenant lock; the row locks hold them
      // off until this write lands, so it never overwrites one.
      .for('update', { of: [projectProspects, prospects] }),
    emails.length > 0
      ? db.select({ email: prospects.email }).from(prospects).where(and(eq(prospects.tenantId, tenantId), inArray(prospects.email, emails)))
      : Promise.resolve([]),
    forms.length > 0
      ? db.select({ id: prospects.id, form: prospects.contactFormUrl }).from(prospects).where(and(eq(prospects.tenantId, tenantId), inArray(prospects.contactFormUrl, forms)))
      : Promise.resolve([]),
    db.select({ prospectId: discoveryCharges.prospectId }).from(discoveryCharges).where(and(eq(discoveryCharges.tenantId, tenantId), inArray(discoveryCharges.prospectId, ids))),
    rows.some((r) => r.verdict === 'billable') ? getTenantPlan(db, tenantId, edition).then((tp) => readFoundBudget(db, tenantId, tp)) : Promise.resolve(null),
    loadProjectOutboundAllowlist(db, projectId),
  ])
  const held = new Map(open.map((r) => [r.id, r]))
  const used = new Set(takenEmails.flatMap((r) => (r.email ? [r.email] : [])))
  const formOwner = new Map(takenForms.flatMap((r) => (r.form ? [[r.form, r.id] as const] : [])))
  const chargedBefore = new Set(charged.map((r) => r.prospectId))
  const { outboundChannels: channels } = allowlist
  const skipped = new Map<number, 'plan_limit' | DedupSkipReason>()
  const emailsToVerify: string[] = []
  const now = new Date()
  for (const { prospectId, input: found, verdict } of rows) {
    const row = held.get(prospectId)
    if (row === undefined) {
      skipped.set(prospectId, 'already_in_project')
      continue
    }
    if (verdict === 'unqualified') continue
    const { contactFormUrl, formType, formNoSolicitation, snsAccounts, ...rest } = found
    const input = {
      ...rest,
      ...(row.form === null && { contactFormUrl, formType, formNoSolicitation }),
      ...(row.sns === null && { snsAccounts }),
    }
    if (input.email && used.has(input.email)) {
      skipped.set(prospectId, 'email_duplicate')
      continue
    }
    const formHolder = input.contactFormUrl ? formOwner.get(input.contactFormUrl) : undefined
    if (formHolder !== undefined && formHolder !== prospectId) {
      skipped.set(prospectId, 'form_url_duplicate')
      continue
    }
    const mayCharge = verdict === 'billable' && row.origin === 'found' && !chargedBefore.has(prospectId) && !reachableOnFile(row, channels)
    const registration = mayCharge ? nextFound(budget) : ({ charge: false } as const)
    if (!registration) {
      skipped.set(prospectId, 'plan_limit')
      continue
    }
    const [after] = await db
      .update(prospects)
      .set(prospectUpdateSet(input, row.organizationId, now))
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, prospectId)))
      .returning({
        email: prospects.email,
        emailNoSolicitation: prospects.emailNoSolicitation,
        form: prospects.contactFormUrl,
        formNoSolicitation: prospects.formNoSolicitation,
        sns: prospects.snsAccounts,
      })
    await db
      .update(projectProspects)
      .set({ qualified: true, matchReason: input.matchReason!, updatedAt: now })
      .where(and(eq(projectProspects.tenantId, tenantId), eq(projectProspects.projectId, projectId), eq(projectProspects.prospectId, prospectId)))
    if (mayCharge && after && reachableOnFile(after, channels)) await spendFound(db, tenantId, prospectId, budget, registration, now)
    if (input.email) {
      used.add(input.email)
      if (!input.emailNoSolicitation) emailsToVerify.push(input.email)
    }
    if (input.contactFormUrl) formOwner.set(input.contactFormUrl, prospectId)
  }
  return ok({ skipped, emailsToVerify })
}

export type DedupDecisionKind = 'fresh' | 'skip'
export type DedupDecision =
  | { kind: 'fresh' }
  | { kind: 'skip'; reason: DedupSkipReason }

export type CheckDedupResult = {
  decisions: DedupDecision[]
}

// One decision per input candidate, in input order. Read-only mirror of
// batchRegister's dedup pass: an existing-row 'overwrite' is reported as
// the channel-specific *_duplicate skip.
export async function checkProspectDedup(
  db: Db,
  tenantId: TenantId,
  input: CheckDedupInput,
): Promise<ServiceResult<CheckDedupResult>> {
  const { projectId: projectRef, candidates } = input

  const resolved = projectRef ? await resolveProject(db, tenantId, projectRef) : null
  if (resolved && !resolved.ok) return resolved
  const projectId = resolved?.value

  const dedup = await buildDedupIndex(db, tenantId, projectId, candidates)

  const decisions: DedupDecision[] = []
  for (const candidate of candidates) {
    const resolution = resolveDedup(dedup, projectId, candidate)
    if (resolution.kind === 'skip') {
      decisions.push({ kind: 'skip', reason: resolution.reason })
      continue
    }
    if (resolution.kind === 'overwrite') {
      decisions.push({ kind: 'skip', reason: overwriteSourceToSkipReason(resolution.source) })
      continue
    }
    decisions.push({ kind: 'fresh' })
    claimRow(dedup, projectId, candidate)
  }

  return ok({ decisions })
}

type ImportSkipped = { row: number; name: string; reason: 'plan_limit' | DedupSkipReason }
type ImportError = { row: number; error: string }

export type ImportCsvResult = {
  inserted: number
  overwritten: number
  skipped: number
  errors: number
  insertedIds: number[]
  overwrittenIds: number[]
  skippedDetails: ImportSkipped[]
  errorDetails: ImportError[]
  // Emails for the caller to resolve via the background deliverability stamp.
  emailsToVerify: string[]
}

export async function importCsv(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: ImportInput,
): Promise<ServiceResult<ImportCsvResult>> {
  const { projectId: projectRef, csvText, dedupPolicy } = input

  const [resolved, tp] = await Promise.all([
    projectRef ? resolveProject(db, tenantId, projectRef) : Promise.resolve(null),
    getTenantPlan(db, tenantId, edition),
  ])
  if (resolved && !resolved.ok) return resolved
  const projectId = resolved?.value

  let rows: string[][] | null
  try {
    rows = parseCsv(csvText, MAX_IMPORT_ROWS + 1)
  } catch (e) {
    return err('INVALID_INPUT', 'CSV parse error', e instanceof Error ? e.message : String(e))
  }
  if (!rows) {
    return err('INVALID_INPUT', `CSV too large (max ${MAX_IMPORT_ROWS} data rows)`)
  }

  if (rows.length < 2) {
    return err('INVALID_INPUT', 'CSV must contain a header row and at least one data row')
  }

  const header = (rows[0] ?? []).map((h) => h.trim())
  const headerCheck = validateCsvHeader(header, Boolean(projectId))
  if (!headerCheck.ok) {
    return err('INVALID_INPUT', headerCheck.error, headerCheck.detail)
  }

  // Lifetime prospect limit counts new insertions only, not overwrites.
  const limits = getPlanLimits(tp.plan)
  let prospectBudget: number | null = null
  if (limits.maxProspects !== null) {
    const currentCount = await countTenantProspects(db, tenantId)
    prospectBudget = Math.max(0, limits.maxProspects - currentCount)
  }

  type ParsedRow = { row: number; name: string; input: ProspectInput }
  const parsedRows: ParsedRow[] = []
  const errors: ImportError[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length === 0 || (row.length === 1 && (row[0] ?? '').trim() === '')) continue

    const parsed = csvRowToInput(header, row)
    if (!parsed.ok) {
      errors.push({ row: i + 1, error: parsed.error })
      continue
    }
    const rowInput = parsed.value
    if (projectId && (!rowInput.matchReason || rowInput.matchReason.trim() === '')) {
      errors.push({ row: i + 1, error: 'matchReason: required when projectId is provided' })
      continue
    }
    const industryProblem = unknownIndustryDetail(rowInput.industry)
    if (industryProblem) {
      errors.push({ row: i + 1, error: industryProblem })
      continue
    }
    parsedRows.push({ row: i + 1, name: rowInput.name, input: rowInput })
  }

  const dedup = await buildDedupIndex(db, tenantId, projectId, parsedRows.map((r) => r.input))

  const inserted: number[] = []
  const overwritten: number[] = []
  const skipped: ImportSkipped[] = []
  const emailsToVerify: string[] = []

  for (const { row: rowNum, name: rowKey, input: rowInput } of parsedRows) {
    const resolution = resolveDedup(dedup, projectId, rowInput)

    if (resolution.kind === 'skip') {
      skipped.push({ row: rowNum, name: rowKey, reason: resolution.reason })
      continue
    }

    if (resolution.kind === 'overwrite') {
      if (dedupPolicy === 'skip') {
        skipped.push({ row: rowNum, name: rowKey, reason: overwriteSourceToSkipReason(resolution.source) })
        continue
      }

      const now = new Date()
      const org = await upsertOrganization(db, tenantId, rowInput, now)
      if (!org) continue

      await db
        .update(prospects)
        .set(prospectUpdateSet(rowInput, org.id, now))
        .where(and(eq(prospects.id, resolution.existingProspectId), eq(prospects.tenantId, tenantId)))

      if (projectId) {
        await db
          .insert(projectProspects)
          .values(projectProspectInsertValues({
            tenantId,
            projectId,
            prospectId: resolution.existingProspectId,
            matchReason: rowInput.matchReason!,
            priority: rowInput.priority,
            now,
          }))
          .onConflictDoUpdate({
            target: [projectProspects.projectId, projectProspects.prospectId],
            set: {
              matchReason: sql`excluded.match_reason`,
              priority: sql`excluded.priority`,
              updatedAt: now,
            },
          })
      }

      overwritten.push(resolution.existingProspectId)
      if (rowInput.email) emailsToVerify.push(rowInput.email)
      claimRow(dedup, projectId, rowInput)
      continue
    }

    if (prospectBudget !== null && inserted.length >= prospectBudget) {
      skipped.push({ row: rowNum, name: rowKey, reason: 'plan_limit' })
      continue
    }

    const now = new Date()
    const org = await upsertOrganization(db, tenantId, rowInput, now)
    if (!org) continue

    const [newProspect] = await db
      .insert(prospects)
      .values(prospectInsertValues(tenantId, rowInput, org.id, now, 'brought_in'))
      .returning({ id: prospects.id })
    if (!newProspect) continue

    if (projectId) {
      await db.insert(projectProspects).values(projectProspectInsertValues({
        tenantId,
        projectId,
        prospectId: newProspect.id,
        matchReason: rowInput.matchReason!,
        priority: rowInput.priority,
        now,
      }))
    }

    claimRow(dedup, projectId, rowInput)
    inserted.push(newProspect.id)
    if (rowInput.email) emailsToVerify.push(rowInput.email)
  }

  return ok({
    inserted: inserted.length,
    overwritten: overwritten.length,
    skipped: skipped.length,
    errors: errors.length,
    insertedIds: inserted,
    overwrittenIds: overwritten,
    skippedDetails: skipped,
    errorDetails: errors,
    emailsToVerify,
  })
}

// Country and employeeBand are bootstrapped on initial INSERT only
// (caller-supplied > TLD inference for country). ON CONFLICT keeps the
// existing values to avoid silent overwrites; explicit updates go through
// PATCH /organizations/:id.
async function upsertOrganization(
  db: Db,
  tenantId: TenantId,
  input: {
    organizationDomain: string
    organizationName: string
    organizationWebsiteUrl: string
    country?: string
    countrySource?: 'manual' | 'ai_inferred'
    employeeBand?: EmployeeBand
  },
  now: Date,
): Promise<{ id: number } | null> {
  const bootstrap = deriveOrgCountryBootstrap(input)
  const [org] = await db
    .insert(organizations)
    .values({
      tenantId,
      domain: input.organizationDomain,
      name: input.organizationName,
      websiteUrl: input.organizationWebsiteUrl,
      country: bootstrap.country,
      countrySource: bootstrap.countrySource,
      employeeBand: input.employeeBand ?? 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [organizations.tenantId, organizations.domain],
      set: {
        name: sql`excluded.name`,
        websiteUrl: sql`excluded.website_url`,
        updatedAt: now,
      },
    })
    .returning({ id: organizations.id })
  return org ?? null
}

// When neither source yields a country, null lets the send-time guardrail
// warn instead of block.
function deriveOrgCountryBootstrap(input: {
  organizationDomain: string
  country?: string
  countrySource?: 'manual' | 'ai_inferred'
}): { country: string | null; countrySource: CountrySource | null } {
  if (input.country) {
    return {
      country: input.country.toUpperCase(),
      countrySource: input.countrySource ?? 'manual',
    }
  }
  const inferred = inferCountryFromDomain(input.organizationDomain)
  if (inferred) return { country: inferred.country, countrySource: inferred.source }
  return { country: null, countrySource: null }
}
