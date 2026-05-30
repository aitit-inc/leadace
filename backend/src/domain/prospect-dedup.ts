import type { ProjectId } from './ids'

// Pre-flight subset of a prospect's identifiers — the keys available before
// paying for contact retrieval.
export type DedupCandidate = {
  organizationDomain: string
  email?: string
  contactFormUrl?: string
}

// Built once per request from the union of every candidate row's identifiers
// — turns the per-row N+1 lookup loop into 3 IN-clause queries. The `claimed*`
// sets implement intra-batch "first wins" semantics.
export type DedupIndex = {
  byEmail: Map<string, { id: number; doNotContact: boolean }>
  byForm: Map<string, { id: number }>
  domainsInProject: Set<string>
  claimedEmails: Set<string>
  claimedForms: Set<string>
  claimedDomains: Set<string>
}

export type DedupSkipReason =
  | 'do_not_contact'
  | 'email_duplicate'
  | 'form_url_duplicate'
  | 'already_in_project'
  | 'duplicate_in_batch'

// `source` records which channel actually matched, so a row with both email
// and form URL where only the form matched reports 'form_url_duplicate'.
export type DedupOverwriteSource = 'email' | 'form'

export type DedupResolution =
  | { kind: 'skip'; reason: DedupSkipReason }
  | { kind: 'insert' }
  | { kind: 'overwrite'; existingProspectId: number; source: DedupOverwriteSource }

export function overwriteSourceToSkipReason(source: DedupOverwriteSource): DedupSkipReason {
  switch (source) {
    case 'email': return 'email_duplicate'
    case 'form': return 'form_url_duplicate'
  }
}

// Single source of truth for the intra-batch project/domain claim key, used by
// both the check (resolveDedup) and the add (claimRow) so the two can never
// drift. The space separator is unambiguous: a nanoid projectId and a
// normalized domain never contain spaces.
const claimedDomainKey = (projectId: ProjectId, organizationDomain: string): string =>
  `${projectId} ${organizationDomain}`

// Channel priority is email > form > domain. DNC on an existing email blocks
// any update. Intra-batch claim sets implement "first wins": a later row that
// collides with an earlier row is reported as duplicate_in_batch.
export function resolveDedup(
  idx: DedupIndex,
  projectId: ProjectId | undefined,
  input: DedupCandidate,
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
    if (idx.claimedDomains.has(claimedDomainKey(projectId, input.organizationDomain))) {
      return { kind: 'skip', reason: 'duplicate_in_batch' }
    }
  }
  return { kind: 'insert' }
}

export function claimRow(
  idx: DedupIndex,
  projectId: ProjectId | undefined,
  input: DedupCandidate,
): void {
  if (input.email) idx.claimedEmails.add(input.email)
  if (input.contactFormUrl) idx.claimedForms.add(input.contactFormUrl)
  if (projectId) idx.claimedDomains.add(claimedDomainKey(projectId, input.organizationDomain))
}
