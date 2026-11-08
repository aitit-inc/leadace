import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { discoveryEvidence, organizations, projectProspects, prospects } from '../db/schema'
import type { ProjectId, TenantId } from '../domain/ids'
import type { KnownOrganization } from '../domain/prospect-dedup'
import { hasContactExpr } from './prospects'

export async function loadKnownOrganizations(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  domains: string[],
): Promise<Map<string, KnownOrganization>> {
  if (domains.length === 0) return new Map()
  const [held, read] = await Promise.all([
    db
      .select({
        domain: organizations.domain,
        id: prospects.id,
        status: projectProspects.status,
        doNotContact: sql<boolean>`${prospects.doNotContact} OR ${organizations.doNotContact}`,
        qualified: projectProspects.qualified,
        hasEmail: sql<boolean>`${prospects.email} IS NOT NULL`,
        hasContact: sql<boolean>`${hasContactExpr}`,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(and(eq(projectProspects.tenantId, tenantId), eq(projectProspects.projectId, projectId), inArray(organizations.domain, domains))),
    db
      .select({ domain: organizations.domain, pageUrl: discoveryEvidence.pageUrl })
      .from(discoveryEvidence)
      .innerJoin(organizations, eq(organizations.id, discoveryEvidence.organizationId))
      .where(and(eq(discoveryEvidence.tenantId, tenantId), eq(discoveryEvidence.projectId, projectId), inArray(organizations.domain, domains))),
  ])
  const known = new Map<string, { prospects: KnownOrganization['prospects']; judgedPages: Set<string> }>()
  const entry = (domain: string) => {
    const found = known.get(domain) ?? { prospects: [], judgedPages: new Set<string>() }
    known.set(domain, found)
    return found
  }
  for (const { domain, ...p } of held) entry(domain).prospects.push(p)
  for (const { domain, pageUrl } of read) entry(domain).judgedPages.add(pageUrl)
  return known
}

export type Evidence = { url: string; claim: string; statedOn: string | null }

// pages: the cited pages a judgment read; evidence: the page a fit rests on.
export type Judged = { domain: string; pages: string[]; evidence: Evidence | null }

// A page read for a judgment that found no fit keeps the claim an earlier one
// found there.
export async function recordEvidence(db: Db, tenantId: TenantId, projectId: ProjectId, judged: Judged[]): Promise<void> {
  const domains = [...new Set(judged.map((j) => j.domain))]
  if (domains.length === 0) return
  const orgs = await db
    .select({ id: organizations.id, domain: organizations.domain })
    .from(organizations)
    .where(and(eq(organizations.tenantId, tenantId), inArray(organizations.domain, domains)))
  const orgOf = new Map(orgs.map((o) => [o.domain, o.id]))
  const judgedAt = new Date()
  const rows = judged.flatMap((j) => {
    const organizationId = orgOf.get(j.domain)
    return organizationId === undefined ? [] : [{ ...j, organizationId }]
  })
  const read = rows.flatMap(({ organizationId, pages, evidence }) =>
    pages.filter((pageUrl) => pageUrl !== evidence?.url).map((pageUrl) => ({ tenantId, projectId, organizationId, pageUrl, judgedAt })),
  )
  // One row per page: an upsert may not touch a row twice, and a batch can
  // carry the same organization twice.
  const fits = [...new Map(rows.flatMap(({ organizationId, evidence }) =>
    evidence === null ? [] : [[`${organizationId} ${evidence.url}`, { tenantId, projectId, organizationId, pageUrl: evidence.url, claim: evidence.claim, statedOn: evidence.statedOn, judgedAt }] as const],
  )).values()]
  if (read.length > 0) await db.insert(discoveryEvidence).values(read).onConflictDoNothing()
  if (fits.length > 0) {
    await db
      .insert(discoveryEvidence)
      .values(fits)
      .onConflictDoUpdate({
        target: [discoveryEvidence.projectId, discoveryEvidence.organizationId, discoveryEvidence.pageUrl],
        set: { claim: sql`excluded.claim`, statedOn: sql`excluded.stated_on`, judgedAt },
      })
  }
}
