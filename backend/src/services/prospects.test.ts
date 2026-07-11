import { describe, it, expect } from 'vitest'
import { classifyProspectDeletion } from './prospects'

const deletable = {
  exists: true,
  doNotContact: false,
  hasOutreachHistory: false,
  projectLinkCount: 1,
}

describe('classifyProspectDeletion', () => {
  it('allows a clean single-project prospect', () => {
    expect(classifyProspectDeletion(deletable)).toBeNull()
  })

  it('allows an unlinked prospect (zero project links)', () => {
    expect(classifyProspectDeletion({ ...deletable, projectLinkCount: 0 })).toBeNull()
  })

  it('refuses missing rows', () => {
    expect(classifyProspectDeletion({ ...deletable, exists: false })).toBe('not_found')
  })

  it('refuses DNC rows — suppression outranks everything', () => {
    expect(
      classifyProspectDeletion({
        exists: true,
        doNotContact: true,
        hasOutreachHistory: true,
        projectLinkCount: 3,
      }),
    ).toBe('do_not_contact')
  })

  it('refuses history-carrying rows (audit rows included)', () => {
    expect(classifyProspectDeletion({ ...deletable, hasOutreachHistory: true })).toBe(
      'has_outreach_history',
    )
  })

  it('refuses rows linked to more than one project', () => {
    expect(classifyProspectDeletion({ ...deletable, projectLinkCount: 2 })).toBe(
      'linked_to_multiple_projects',
    )
  })
})
