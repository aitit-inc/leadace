import { and, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { draftReviews, outreachLogs, projectProspects, prospects } from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, TenantId } from '../domain/ids'
import { REVIEW_CONCERNS, type DiscardReview, type DraftReviewEntry, type ReviewAudience } from '../domain/draft-review'

type EditPatch = { subject?: string | null; body?: string }

// Keeps the agent's text the first time the person changes a draft; later edits
// leave it alone. Call before applying the edit.
export async function recordDraftEdit(db: Db, tenantId: TenantId, id: number, patch: EditPatch): Promise<void> {
  const changed = or(
    patch.subject !== undefined ? sql`${outreachLogs.subject} IS DISTINCT FROM ${patch.subject}` : undefined,
    patch.body !== undefined ? ne(outreachLogs.body, patch.body) : undefined,
  )
  if (!changed) return
  await db.execute(sql`
    INSERT INTO draft_reviews (tenant_id, project_id, prospect_id, outreach_log_id, channel, verdict, agent_subject, agent_body)
    SELECT ${outreachLogs.tenantId}, ${outreachLogs.projectId}, ${outreachLogs.prospectId}, ${outreachLogs.id}, ${outreachLogs.channel}, 'edited', ${outreachLogs.subject}, ${outreachLogs.body}
    FROM ${outreachLogs}
    WHERE ${and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId), eq(outreachLogs.status, 'pending_review'), changed)}
    ON CONFLICT (outreach_log_id) DO NOTHING`)
}

// Discards the pending drafts `which` selects and records why. The rows are
// locked first, so a draft a concurrent send wins is neither deleted nor
// recorded as discarded.
export async function discardPendingDrafts(db: Db, tenantId: TenantId, which: SQL, review: DiscardReview): Promise<number[]> {
  const doomed = await db
    .select({
      id: outreachLogs.id,
      projectId: outreachLogs.projectId,
      prospectId: outreachLogs.prospectId,
      channel: outreachLogs.channel,
      subject: outreachLogs.subject,
      body: outreachLogs.body,
    })
    .from(outreachLogs)
    .where(and(which, eq(outreachLogs.tenantId, tenantId), eq(outreachLogs.status, 'pending_review')))
    .for('update')
  if (doomed.length === 0) return []

  // A draft the person had already edited keeps the agent's original text.
  await db
    .insert(draftReviews)
    .values(doomed.map((d) => ({
      tenantId,
      projectId: d.projectId,
      prospectId: d.prospectId,
      outreachLogId: d.id,
      channel: d.channel,
      verdict: review.verdict,
      note: review.note,
      agentSubject: d.subject,
      agentBody: d.body,
    })))
    .onConflictDoUpdate({ target: draftReviews.outreachLogId, set: { verdict: review.verdict, note: review.note } })

  if (review.verdict === 'wrong_prospect') {
    for (const projectId of new Set(doomed.map((d) => d.projectId))) {
      await db
        .update(projectProspects)
        .set({ status: 'inactive', updatedAt: new Date() })
        .where(and(
          eq(projectProspects.tenantId, tenantId),
          eq(projectProspects.projectId, projectId),
          inArray(projectProspects.prospectId, doomed.filter((d) => d.projectId === projectId).map((d) => d.prospectId)),
        ))
    }
  }

  const ids = doomed.map((d) => d.id)
  await db.delete(outreachLogs).where(and(inArray(outreachLogs.id, ids), eq(outreachLogs.tenantId, tenantId)))
  return ids
}

const FEEDBACK_LIMIT = 8

// The person's latest corrections that say something: an edit that reached the
// recipient, a wrong-prospect call, a discard with a reason given.
export async function getDraftReviewFeedback(db: Db, tenantId: TenantId, projectId: ProjectId, audience: ReviewAudience): Promise<DraftReviewEntry[]> {
  const rows = await db
    .select({
      verdict: draftReviews.verdict,
      note: draftReviews.note,
      channel: draftReviews.channel,
      agentSubject: draftReviews.agentSubject,
      agentBody: draftReviews.agentBody,
      sentSubject: outreachLogs.subject,
      sentBody: outreachLogs.body,
      prospectName: prospects.name,
      industry: prospects.industry,
    })
    .from(draftReviews)
    .innerJoin(prospects, eq(prospects.id, draftReviews.prospectId))
    .leftJoin(outreachLogs, eq(outreachLogs.id, draftReviews.outreachLogId))
    .where(and(
      eq(draftReviews.tenantId, tenantId),
      eq(draftReviews.projectId, projectId),
      // Before the limit: a run of edits must not crowd out the one wrong-prospect call.
      inArray(draftReviews.verdict, [...REVIEW_CONCERNS[audience]]),
      or(
        and(
          eq(draftReviews.verdict, 'edited'),
          eq(outreachLogs.status, 'sent'),
          or(ne(outreachLogs.body, draftReviews.agentBody), sql`${outreachLogs.subject} IS DISTINCT FROM ${draftReviews.agentSubject}`),
        ),
        eq(draftReviews.verdict, 'wrong_prospect'),
        and(eq(draftReviews.verdict, 'wrong_message'), isNotNull(draftReviews.note)),
      ),
    ))
    .orderBy(desc(draftReviews.createdAt), desc(draftReviews.id))
    .limit(FEEDBACK_LIMIT)

  return rows.flatMap((r): DraftReviewEntry[] => {
    const reviewed = { channel: r.channel, prospectName: r.prospectName, industry: r.industry, agentSubject: r.agentSubject, agentBody: r.agentBody }
    if (r.verdict !== 'edited') return [{ ...reviewed, verdict: r.verdict, note: r.note }]
    return r.sentBody === null ? [] : [{ ...reviewed, verdict: 'edited', sentSubject: r.sentSubject, sentBody: r.sentBody }]
  })
}
