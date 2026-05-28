import { z } from 'zod'
import { eq, and, sql, desc, or, ilike, inArray, ne } from 'drizzle-orm'
import {
  organizations,
  prospects,
  projectProspects,
  outreachLogs,
  responses,
  channelEnum,
  outreachStatusEnum,
  sentimentEnum,
  responseTypeEnum,
  type SnsAccounts,
  type OutreachStatus,
} from '../db/schema'
import type { Db } from '../db/connection'
import { type TenantId } from '../domain/ids'
export { organizationIdParamSchema } from '../domain/ids'
import { isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG } from '../domain/url'
import { ok, err, type ServiceResult } from './result'

type Channel = (typeof channelEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]
type ResponseType = (typeof responseTypeEnum.enumValues)[number]

const PROSPECT_HISTORY_PER_PROSPECT = 50

export type OrganizationRow = typeof organizations.$inferSelect

export type OrganizationListItem = {
  id: number
  name: string
  domain: string
  websiteUrl: string
  createdAt: Date
  updatedAt: Date
  prospectCount: number
  projectCount: number
}

export type OrganizationProspectRow = {
  id: number
  name: string
  contactName: string | null
  department: string | null
  overview: string
  industry: string | null
  websiteUrl: string
  email: string | null
  contactFormUrl: string | null
  snsAccounts: SnsAccounts | null
  doNotContact: boolean
  notes: string | null
  createdAt: Date
  projectCount: number
  outreachCount: number
  responseCount: number
  lastInteractionAt: Date | null
  interactions: OrganizationProspectInteraction[]
}

// Discriminated union: each row is either an outbound outreach attempt or an
// inbound response. Frontend renders these in a single timeline per prospect.
export type OrganizationProspectInteraction =
  | {
      type: 'outreach'
      id: number
      channel: Channel
      status: OutreachStatus
      subject: string | null
      sentAt: Date
    }
  | {
      type: 'response'
      id: number
      outreachLogId: number
      channel: Channel
      sentiment: Sentiment
      responseType: ResponseType
      receivedAt: Date
    }

export const listOrganizationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
})
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>

// Domain is immutable: it is the dedup key for organizations within a tenant.
export const updateOrganizationBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  })
export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>

export async function listOrganizations(
  db: Db,
  tenantId: TenantId,
  query: ListOrganizationsQuery,
): Promise<ServiceResult<{ organizations: OrganizationListItem[]; total: number }>> {
  const { limit, offset, q } = query

  const conditions = [eq(organizations.tenantId, tenantId)]
  if (q) {
    const like = `%${q}%`
    conditions.push(or(ilike(organizations.name, like), ilike(organizations.domain, like))!)
  }

  const where = and(...conditions)

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        domain: organizations.domain,
        websiteUrl: organizations.websiteUrl,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        prospectCount: sql<number>`COUNT(DISTINCT ${prospects.id})::int`,
        projectCount: sql<number>`COUNT(DISTINCT ${projectProspects.projectId})::int`,
      })
      .from(organizations)
      .leftJoin(prospects, eq(prospects.organizationId, organizations.id))
      .leftJoin(projectProspects, eq(projectProspects.prospectId, prospects.id))
      .where(where)
      .groupBy(organizations.id)
      .orderBy(desc(organizations.updatedAt), desc(organizations.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(organizations)
      .where(where),
  ])

  return ok({
    organizations: rows,
    total: countRows[0]?.total ?? 0,
  })
}

export async function getOrganization(
  db: Db,
  tenantId: TenantId,
  id: number,
): Promise<ServiceResult<{ organization: OrganizationRow; prospects: OrganizationProspectRow[] }>> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, id), eq(organizations.tenantId, tenantId)))
    .limit(1)

  if (!org) return err('NOT_FOUND', 'Organization not found')

  const baseRows = await db
    .select({
      id: prospects.id,
      name: prospects.name,
      contactName: prospects.contactName,
      department: prospects.department,
      overview: prospects.overview,
      industry: prospects.industry,
      websiteUrl: prospects.websiteUrl,
      email: prospects.email,
      contactFormUrl: prospects.contactFormUrl,
      snsAccounts: prospects.snsAccounts,
      doNotContact: prospects.doNotContact,
      notes: prospects.notes,
      createdAt: prospects.createdAt,
      projectCount: sql<number>`COUNT(DISTINCT ${projectProspects.projectId})::int`,
    })
    .from(prospects)
    .leftJoin(projectProspects, eq(projectProspects.prospectId, prospects.id))
    .where(and(eq(prospects.organizationId, id), eq(prospects.tenantId, tenantId)))
    .groupBy(prospects.id)
    .orderBy(desc(prospects.createdAt))

  const prospectIds = baseRows.map((r) => r.id)
  const byProspect = new Map<number, OrganizationProspectInteraction[]>()
  prospectIds.forEach((pid) => byProspect.set(pid, []))

  if (prospectIds.length > 0) {
    const [outreachRows, responseRows] = await Promise.all([
      db
        .select({
          id: outreachLogs.id,
          prospectId: outreachLogs.prospectId,
          channel: outreachLogs.channel,
          status: outreachLogs.status,
          subject: outreachLogs.subject,
          sentAt: outreachLogs.sentAt,
        })
        .from(outreachLogs)
        .where(and(
          eq(outreachLogs.tenantId, tenantId),
          inArray(outreachLogs.prospectId, prospectIds),
          ne(outreachLogs.status, 'pre_send'),
        ))
        .orderBy(desc(outreachLogs.sentAt)),
      db
        .select({
          id: responses.id,
          outreachLogId: responses.outreachLogId,
          prospectId: outreachLogs.prospectId,
          channel: responses.channel,
          sentiment: responses.sentiment,
          responseType: responses.responseType,
          receivedAt: responses.receivedAt,
        })
        .from(responses)
        .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
        .where(and(
          eq(responses.tenantId, tenantId),
          inArray(outreachLogs.prospectId, prospectIds),
        ))
        .orderBy(desc(responses.receivedAt)),
    ])

    for (const row of outreachRows) {
      const list = byProspect.get(row.prospectId)
      if (!list) continue
      list.push({
        type: 'outreach',
        id: row.id,
        channel: row.channel,
        status: row.status,
        subject: row.subject,
        sentAt: row.sentAt,
      })
    }
    for (const row of responseRows) {
      const list = byProspect.get(row.prospectId)
      if (!list) continue
      list.push({
        type: 'response',
        id: row.id,
        outreachLogId: row.outreachLogId,
        channel: row.channel,
        sentiment: row.sentiment,
        responseType: row.responseType,
        receivedAt: row.receivedAt,
      })
    }
    for (const list of byProspect.values()) {
      list.sort((a, b) => {
        const at = a.type === 'outreach' ? a.sentAt : a.receivedAt
        const bt = b.type === 'outreach' ? b.sentAt : b.receivedAt
        return bt.getTime() - at.getTime()
      })
    }
  }

  const orgProspects: OrganizationProspectRow[] = baseRows.map((r) => {
    const all = byProspect.get(r.id) ?? []
    let outreachCount = 0
    let responseCount = 0
    let lastInteractionAt: Date | null = null
    for (const i of all) {
      if (i.type === 'outreach') outreachCount++
      else responseCount++
      const t = i.type === 'outreach' ? i.sentAt : i.receivedAt
      if (!lastInteractionAt || t > lastInteractionAt) lastInteractionAt = t
    }
    const interactions = all.length > PROSPECT_HISTORY_PER_PROSPECT
      ? all.slice(0, PROSPECT_HISTORY_PER_PROSPECT)
      : all
    return {
      ...r,
      outreachCount,
      responseCount,
      lastInteractionAt,
      interactions,
    }
  })

  return ok({ organization: org, prospects: orgProspects })
}

export async function updateOrganization(
  db: Db,
  tenantId: TenantId,
  id: number,
  body: UpdateOrganizationBody,
): Promise<ServiceResult<{ organization: OrganizationRow }>> {
  const [updated] = await db
    .update(organizations)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(organizations.id, id), eq(organizations.tenantId, tenantId)))
    .returning()

  if (!updated) return err('NOT_FOUND', 'Organization not found')
  return ok({ organization: updated })
}
