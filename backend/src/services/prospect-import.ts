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
  projectIdSchema,
  type ProjectId,
  type TenantId,
} from '../domain/ids'
import {
  getTenantPlan,
  getPlanLimits,
  countTenantProspects,
} from './plan-limits'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'
import { parseCsv } from '../domain/csv'
import type { Edition } from '../domain/edition'
import { projectProspectInsertValues } from '../domain/project-prospect'
import { inferCountryFromDomain } from '../domain/country'
import { normalizeDomain } from '../domain/normalize-domain'
import { isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG } from '../domain/url'

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
  // Optional. Caller may NOT claim 'tld_inferred' as the source; only the
  // server writes that on bootstrap.
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
  notes: z.string().optional(),
  hypothesis: hypothesisSchema.optional(),
  // One-way ratchet on import: true sets/keeps DNC; false (or omitted) never clears.
  doNotContact: z.boolean().optional(),
  // Only consulted when projectId is set on the request.
  matchReason: z.string().min(1).optional(),
  priority: prioritySchema.default(3),
}).refine(
  (p) => p.email || p.contactFormUrl || (p.snsAccounts && Object.values(p.snsAccounts).some(Boolean)),
  { message: 'At least one contact channel (email, contactFormUrl, or snsAccounts) is required' },
)
type ProspectInput = z.infer<typeof prospectInputSchema>

export const batchSchema = z.object({
  projectId: projectIdSchema.optional(),
  prospects: z.array(prospectInputSchema).min(1).max(100),
})
export type BatchInput = z.infer<typeof batchSchema>

export const importSchema = z.object({
  projectId: projectIdSchema.optional(),
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
})

export const checkDedupSchema = z.object({
  projectId: projectIdSchema.optional(),
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
  'notes',
  'priority',
  'doNotContact',
  'country',
  'countrySource',
])

const DNC_TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const DNC_FALSY = new Set(['0', 'false', 'no', 'off'])

const MAX_IMPORT_ROWS = 1000

function csvRowToInput(header: string[], row: string[]): { ok: true; value: ProspectInput } | { ok: false; error: string } {
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

// Insert and update have asymmetric semantics:
//   - INSERT seeds every column with `... ?? null`.
//   - UPDATE (overwrite path) only touches columns the caller explicitly
//     supplied — a sparse CSV row that omits `notes` must not NULL existing
//     notes. Optional columns are spread conditionally so an absent key
//     never produces an UPDATE clause.
// Required scalar columns (name / overview / websiteUrl / organizationId)
// always update; the CSV schema forbids them from being absent.

// Only emits keys when the caller explicitly supplies a country, preserving
// the existing prospect.country on the overwrite path. Org country is the
// primary signal; prospect.country is for "person located in a different
// country than their employer".
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

function prospectInsertValues(tenantId: TenantId, input: ProspectInput, orgId: number, now: Date) {
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
    notes: input.notes ?? null,
    hypothesis: (input.hypothesis as ProspectHypothesis) ?? null,
    ...prospectCountryPatch(input),
    doNotContact: input.doNotContact ?? false,
    createdAt: now,
    updatedAt: now,
  }
}

function prospectUpdateSet(input: ProspectInput, orgId: number, now: Date) {
  return {
    name: input.name,
    organizationId: orgId,
    overview: input.overview,
    websiteUrl: input.websiteUrl,
    ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.department !== undefined ? { department: input.department } : {}),
    ...(input.industry !== undefined ? { industry: input.industry } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.contactFormUrl !== undefined ? { contactFormUrl: input.contactFormUrl } : {}),
    ...(input.formType !== undefined ? { formType: input.formType } : {}),
    ...(input.snsAccounts !== undefined ? { snsAccounts: input.snsAccounts as SnsAccounts } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis as ProspectHypothesis } : {}),
    ...prospectCountryPatch(input),
    // One-way DNC ratchet: only set true; imports never clear an existing flag.
    ...(input.doNotContact === true ? { doNotContact: true } : {}),
    updatedAt: now,
  }
}

// Built once per request from the union of every candidate row's identifiers
// — turns the per-row N+1 lookup loop into 3 IN-clause queries. The `claimed*`
// sets implement intra-batch "first wins" semantics.
type DedupIndex = {
  byEmail: Map<string, { id: number; doNotContact: boolean }>
  byForm: Map<string, { id: number }>
  domainsInProject: Set<string>
  claimedEmails: Set<string>
  claimedForms: Set<string>
  claimedDomains: Set<string>
}

async function buildDedupIndex(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  inputs: ReadonlyArray<Pick<ProspectInput, 'email' | 'contactFormUrl' | 'organizationDomain'>>,
): Promise<DedupIndex> {
  const emails = Array.from(
    new Set(inputs.map((i) => i.email).filter((v): v is string => Boolean(v))),
  )
  const forms = Array.from(
    new Set(inputs.map((i) => i.contactFormUrl).filter((v): v is string => Boolean(v))),
  )
  const domains = Array.from(
    new Set(inputs.map((i) => i.organizationDomain).filter((v): v is string => Boolean(v))),
  )

  const [byEmailRows, byFormRows, domainRows] = await Promise.all([
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
  const domainsInProject = new Set<string>(domainRows.map((r) => r.domain))

  return {
    byEmail,
    byForm,
    domainsInProject,
    claimedEmails: new Set(),
    claimedForms: new Set(),
    claimedDomains: new Set(),
  }
}

// Discriminated union so callers can make programmatic decisions instead of
// parsing strings.
type DedupSkipReason =
  | 'do_not_contact'
  | 'email_duplicate'
  | 'form_url_duplicate'
  | 'already_in_project'
  | 'duplicate_in_batch'

// `source` records which channel actually matched, so a row with both email
// and form URL where only the form matched reports 'form_url_duplicate'.
type DedupOverwriteSource = 'email' | 'form'

type DedupResolution =
  | { kind: 'skip'; reason: DedupSkipReason }
  | { kind: 'insert' }
  | { kind: 'overwrite'; existingProspectId: number; source: DedupOverwriteSource }

function overwriteSourceToSkipReason(source: DedupOverwriteSource): DedupSkipReason {
  switch (source) {
    case 'email': return 'email_duplicate'
    case 'form': return 'form_url_duplicate'
  }
}

// Intra-batch claim sets implement "first wins": a later row that collides
// with an earlier row is reported as duplicate_in_batch.
function resolveDedup(
  idx: DedupIndex,
  projectId: ProjectId | undefined,
  input: Pick<ProspectInput, 'email' | 'contactFormUrl' | 'organizationDomain'>,
): DedupResolution {
  if (input.email) {
    const hit = idx.byEmail.get(input.email)
    if (hit?.doNotContact) return { kind: 'skip', reason: 'do_not_contact' }
    if (hit) return { kind: 'overwrite', existingProspectId: hit.id, source: 'email' }
    if (idx.claimedEmails.has(input.email)) return { kind: 'skip', reason: 'duplicate_in_batch' }
  }
  if (input.contactFormUrl) {
    const hit = idx.byForm.get(input.contactFormUrl)
    if (hit) return { kind: 'overwrite', existingProspectId: hit.id, source: 'form' }
    if (idx.claimedForms.has(input.contactFormUrl)) return { kind: 'skip', reason: 'duplicate_in_batch' }
  }
  if (projectId) {
    if (idx.domainsInProject.has(input.organizationDomain)) {
      return { kind: 'skip', reason: 'already_in_project' }
    }
    if (idx.claimedDomains.has(`${projectId} ${input.organizationDomain}`)) {
      return { kind: 'skip', reason: 'duplicate_in_batch' }
    }
  }
  return { kind: 'insert' }
}

function claimRow(
  idx: DedupIndex,
  projectId: ProjectId | undefined,
  input: Pick<ProspectInput, 'email' | 'contactFormUrl' | 'organizationDomain'>,
): void {
  if (input.email) idx.claimedEmails.add(input.email)
  if (input.contactFormUrl) idx.claimedForms.add(input.contactFormUrl)
  if (projectId) idx.claimedDomains.add(`${projectId} ${input.organizationDomain}`)
}

type BatchSkipped = { name: string; reason: 'plan_limit' | DedupSkipReason }

export type BatchRegisterResult = {
  inserted: number
  skipped: number
  insertedIds: number[]
  skippedDetails: BatchSkipped[]
}

export async function batchRegister(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: BatchInput,
): Promise<ServiceResult<BatchRegisterResult>> {
  const { projectId, prospects: inputs } = input

  const [guard, tp] = await Promise.all([
    projectId ? requireProject(db, projectId, tenantId) : Promise.resolve(null),
    getTenantPlan(db, tenantId, edition),
  ])
  if (guard && !guard.ok) return guard

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
        },
      )
    }
  }

  const dedup = await buildDedupIndex(db, tenantId, projectId, inputs)

  const inserted: number[] = []
  const skipped: BatchSkipped[] = []

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
  }

  return ok({
    inserted: inserted.length,
    skipped: skipped.length,
    insertedIds: inserted,
    skippedDetails: skipped,
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
  const { projectId, candidates } = input

  const guard = projectId ? await requireProject(db, projectId, tenantId) : null
  if (guard && !guard.ok) return guard

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
}

export async function importCsv(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: ImportInput,
): Promise<ServiceResult<ImportCsvResult>> {
  const { projectId, csvText, dedupPolicy } = input

  const [guard, tp] = await Promise.all([
    projectId ? requireProject(db, projectId, tenantId) : Promise.resolve(null),
    getTenantPlan(db, tenantId, edition),
  ])
  if (guard && !guard.ok) return guard

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
  const missing = REQUIRED_CSV_HEADERS.filter((h) => !header.includes(h))
  if (missing.length > 0) {
    return err('INVALID_INPUT', 'Missing required columns', missing.join(', '))
  }
  if (projectId && !header.includes('matchReason')) {
    return err('INVALID_INPUT', 'Missing required columns', 'matchReason is required when projectId is provided')
  }
  const unknown = header.filter((h) => !ALLOWED_CSV_HEADERS.has(h))
  if (unknown.length > 0) {
    return err('INVALID_INPUT', 'Unknown columns', unknown.join(', '))
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

// Caller-supplied takes precedence over TLD inference; absent both we leave
// it null and let the send-time guardrail warn instead of block.
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
