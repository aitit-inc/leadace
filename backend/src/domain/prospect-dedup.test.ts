import { describe, it, expect } from 'vitest'
import { asProjectId } from './ids'
import { resolveDedup, claimRow, type DedupIndex, type DedupCandidate } from './prospect-dedup'

const proj = asProjectId('proj_1')

const emptyIndex = (): DedupIndex => ({
  byEmail: new Map(),
  byForm: new Map(),
  byPlatform: new Map(),
  dncDomains: new Set(),
  domainsInProject: new Set(),
  claimedEmails: new Set(),
  claimedForms: new Set(),
  claimedPlatforms: new Set(),
  claimedDomains: new Set(),
})

const candidate = (over: Partial<DedupCandidate>): DedupCandidate => ({
  organizationDomain: 'example.com',
  ...over,
})

describe('resolveDedup — existing rows', () => {
  it('overwrites on an existing email match', () => {
    const idx = emptyIndex()
    idx.byEmail.set('a@x.com', { id: 7, doNotContact: false })
    expect(resolveDedup(idx, proj, candidate({ email: 'a@x.com' }))).toEqual({ kind: 'overwrite', existingProspectId: 7, source: 'email' })
  })

  it('blocks any update when the existing email is do_not_contact', () => {
    const idx = emptyIndex()
    idx.byEmail.set('a@x.com', { id: 7, doNotContact: true })
    expect(resolveDedup(idx, proj, candidate({ email: 'a@x.com' }))).toEqual({ kind: 'skip', reason: 'do_not_contact' })
  })

  it('overwrites on an existing form match', () => {
    const idx = emptyIndex()
    idx.byForm.set('https://f', { id: 9 })
    expect(resolveDedup(idx, proj, candidate({ contactFormUrl: 'https://f' }))).toEqual({ kind: 'overwrite', existingProspectId: 9, source: 'form' })
  })

  it('prefers an email match over a form match (channel priority)', () => {
    const idx = emptyIndex()
    idx.byEmail.set('a@x.com', { id: 1, doNotContact: false })
    idx.byForm.set('https://f', { id: 2 })
    expect(resolveDedup(idx, proj, candidate({ email: 'a@x.com', contactFormUrl: 'https://f' })))
      .toEqual({ kind: 'overwrite', existingProspectId: 1, source: 'email' })
  })

  it('skips a domain already linked to the project', () => {
    const idx = emptyIndex()
    idx.domainsInProject.add('example.com')
    expect(resolveDedup(idx, proj, candidate({ email: 'new@x.com' }))).toEqual({ kind: 'skip', reason: 'already_in_project' })
  })

  it('inserts a fresh candidate', () => {
    expect(resolveDedup(emptyIndex(), proj, candidate({ email: 'new@x.com' }))).toEqual({ kind: 'insert' })
  })

  it('does not apply the project-domain check when no project is given', () => {
    const idx = emptyIndex()
    idx.domainsInProject.add('example.com')
    expect(resolveDedup(idx, undefined, candidate({ email: 'new@x.com' }))).toEqual({ kind: 'insert' })
  })

  it('overwrites on an existing platform match', () => {
    const idx = emptyIndex()
    idx.byPlatform.set('https://p/job/1', { id: 11 })
    expect(resolveDedup(idx, proj, candidate({ platformUrl: 'https://p/job/1' })))
      .toEqual({ kind: 'overwrite', existingProspectId: 11, source: 'platform' })
  })

  it('platform candidate bypasses the project-domain check (posting granularity)', () => {
    const idx = emptyIndex()
    idx.domainsInProject.add('example.com')
    expect(resolveDedup(idx, proj, candidate({ platformUrl: 'https://p/job/2' })))
      .toEqual({ kind: 'insert' })
  })
})

describe('resolveDedup — org-level DNC domains', () => {
  it('skips a DNC domain before channel matching, even on an email overwrite match', () => {
    const idx = emptyIndex()
    idx.dncDomains.add('example.com')
    idx.byEmail.set('a@x.com', { id: 7, doNotContact: false })
    expect(resolveDedup(idx, proj, candidate({ email: 'a@x.com' }))).toEqual({ kind: 'skip', reason: 'do_not_contact' })
  })

  it('skips a DNC domain for platform candidates despite their domain-check bypass', () => {
    const idx = emptyIndex()
    idx.dncDomains.add('example.com')
    expect(resolveDedup(idx, proj, candidate({ platformUrl: 'https://p/job/1' })))
      .toEqual({ kind: 'skip', reason: 'do_not_contact' })
  })

  it('applies without a project (workspace-wide, unlike the project-domain check)', () => {
    const idx = emptyIndex()
    idx.dncDomains.add('example.com')
    expect(resolveDedup(idx, undefined, candidate({ email: 'new@x.com' }))).toEqual({ kind: 'skip', reason: 'do_not_contact' })
  })

  it('does not affect other domains', () => {
    const idx = emptyIndex()
    idx.dncDomains.add('blocked.com')
    expect(resolveDedup(idx, proj, candidate({ email: 'new@x.com' }))).toEqual({ kind: 'insert' })
  })
})

describe('resolveDedup — intra-batch "first wins" via claimRow', () => {
  it('reports the second occurrence of an email as duplicate_in_batch', () => {
    const idx = emptyIndex()
    const c = candidate({ email: 'dup@x.com' })
    expect(resolveDedup(idx, proj, c)).toEqual({ kind: 'insert' })
    claimRow(idx, proj, c)
    expect(resolveDedup(idx, proj, c)).toEqual({ kind: 'skip', reason: 'duplicate_in_batch' })
  })

  it('reports the second occurrence of a project+domain as duplicate_in_batch', () => {
    // Guards the claim-key contract: claimRow's add and resolveDedup's check
    // must use the identical key, or this round-trip silently fails.
    const idx = emptyIndex()
    const c = candidate({ email: 'x@a.com', organizationDomain: 'acme.com' })
    claimRow(idx, proj, c)
    expect(resolveDedup(idx, proj, candidate({ email: 'y@b.com', organizationDomain: 'acme.com' })))
      .toEqual({ kind: 'skip', reason: 'duplicate_in_batch' })
  })

  it('reports the second occurrence of a platformUrl as duplicate_in_batch', () => {
    const idx = emptyIndex()
    const c = candidate({ platformUrl: 'https://p/job/1' })
    expect(resolveDedup(idx, proj, c)).toEqual({ kind: 'insert' })
    claimRow(idx, proj, c)
    expect(resolveDedup(idx, proj, c)).toEqual({ kind: 'skip', reason: 'duplicate_in_batch' })
  })

  it('a claimed platform candidate does not block a same-domain candidate at domain granularity', () => {
    const idx = emptyIndex()
    claimRow(idx, proj, candidate({ platformUrl: 'https://p/job/1', organizationDomain: 'platform.com' }))
    expect(resolveDedup(idx, proj, candidate({ platformUrl: 'https://p/job/2', organizationDomain: 'platform.com' })))
      .toEqual({ kind: 'insert' })
    expect(resolveDedup(idx, proj, candidate({ email: 'y@b.com', organizationDomain: 'platform.com' })))
      .toEqual({ kind: 'insert' })
  })
})
