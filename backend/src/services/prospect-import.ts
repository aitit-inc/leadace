import { z } from 'zod'
import { eq, and, sql, inArray } from 'drizzle-orm'
import {
  organizations,
  prospects,
  projectProspects,
  formTypeEnum,
  prioritySchema,
  type SnsAccounts,
  type ProspectHypothesis,
  type CountrySource,
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
  countTenantProspects,
} from './plan-limits'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
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
  hypothesizedPain: z.array(z.string()).optional(),
  valueMapping: z.array(z.string()).optional(),
  timingSignals: z.array(z.string()).optional(),
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
  name: z.string().min(1),
  contactName: z.string().optional(),
  department: z.string().optional(),
  overview: z.string().min(1),
  industry: z.string().optional(),
  websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG),
  email: z.email().optional(),
  contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  formType: z.enum(formTypeEnum.enumValues).optional(),
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
  'contactFormUrl',
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

const DNC_TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const DNC_FALSY = new Set(['0', 'false', 'no', 'off'])

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
    } else if (key === 'doNotContact') {
      const lower = val.toLowerCase()
      if (DNC_TRUTHY.has(lower)) obj.doNotContact = true
      else if (DNC_FALSY.has(lower)) obj.doNotContact = false
      else return { ok: false, error: `doNotContact: not a boolean (got "${val}")` }
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
) {
  return {
    tenantId,
    name: input.name,
    contactName: input.contactName ?? null,
    organizationId: orgId,
    department: input.department ?? null,
    overview: input.overview,
    industry: input.industry ?? null,
    websiteUrl: input.websiteUrl,
    email: input.email ?? null,
    contactFormUrl: input.contactFormUrl ?? null,
    formType: input.formType ?? null,
    snsAccounts: (input.snsAccounts as SnsAccounts) ?? null,
    platformUrl: input.platformUrl ?? null,
    notes: input.notes ?? null,
    hypothesis: (input.hypothesis as ProspectHypothesis) ?? null,
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
        }
      : {}),
    ...(input.contactFormUrl !== undefined ? { contactFormUrl: input.contactFormUrl } : {}),
    ...(input.formType !== undefined ? { formType: input.formType } : {}),
    ...(input.snsAccounts !== undefined ? { snsAccounts: input.snsAccounts as SnsAccounts } : {}),
    ...(input.platformUrl !== undefined ? { platformUrl: input.platformUrl } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis as ProspectHypothesis } : {}),
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

  const [byEmailRows, byFormRows, byPlatformRows, domainRows] = await Promise.all([
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
  const domainsInProject = new Set<string>(domainRows.map((r) => r.domain))

  return {
    byEmail,
    byForm,
    byPlatform,
    domainsInProject,
    claimedEmails: new Set(),
    claimedForms: new Set(),
    claimedPlatforms: new Set(),
    claimedDomains: new Set(),
  }
}

type BatchSkipped = { name: string; reason: 'plan_limit' | DedupSkipReason }

export type BatchRegisterResult = {
  inserted: number
  skipped: number
  insertedIds: number[]
  skippedDetails: BatchSkipped[]
  // Emails for the caller to resolve via the background deliverability stamp.
  emailsToVerify: string[]
}

export async function batchRegister(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: BatchInput,
): Promise<ServiceResult<BatchRegisterResult>> {
  const { projectId: projectRef, prospects: inputs } = input

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

  const dedup = await buildDedupIndex(db, tenantId, projectId, inputs)

  const inserted: number[] = []
  const skipped: BatchSkipped[] = []
  const emailsToVerify: string[] = []

  for (const input of inputs) {
    if (prospectBudget !== null && inserted.length >= prospectBudget) {
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

    const now = new Date()
    const org = await upsertOrganization(db, tenantId, input, now)
    if (!org) continue

    const [newProspect] = await db
      .insert(prospects)
      .values(prospectInsertValues(tenantId, input, org.id, now))
      .returning({ id: prospects.id })

    if (!newProspect) continue

    if (projectId) {
      await db.insert(projectProspects).values(projectProspectInsertValues({
        tenantId,
        projectId,
        prospectId: newProspect.id,
        matchReason: input.matchReason!,
        priority: input.priority,
        now,
      }))
    }

    claimRow(dedup, projectId, input)
    inserted.push(newProspect.id)
    if (input.email) emailsToVerify.push(input.email)
  }

  return ok({
    inserted: inserted.length,
    skipped: skipped.length,
    insertedIds: inserted,
    skippedDetails: skipped,
    emailsToVerify,
  })
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

  let rows: string[][]
  try {
    rows = parseCsv(csvText)
  } catch (e) {
    return err('INVALID_INPUT', 'CSV parse error', e instanceof Error ? e.message : String(e))
  }

  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (!last || last.length === 0 || (last.length === 1 && last[0] === '')) rows.pop()
    else break
  }

  if (rows.length < 2) {
    return err('INVALID_INPUT', 'CSV must contain a header row and at least one data row')
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    return err('INVALID_INPUT', `CSV too large (max ${MAX_IMPORT_ROWS} data rows)`)
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
      .values(prospectInsertValues(tenantId, rowInput, org.id, now))
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

// Country is bootstrapped on initial INSERT only (caller-supplied > TLD
// inference). ON CONFLICT keeps the existing country to avoid silent
// overwrites; explicit updates go through PATCH /organizations/:id.
async function upsertOrganization(
  db: Db,
  tenantId: TenantId,
  input: {
    organizationDomain: string
    organizationName: string
    organizationWebsiteUrl: string
    country?: string
    countrySource?: 'manual' | 'ai_inferred'
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
