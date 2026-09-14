import { describe, it, expect } from 'vitest'
import { capFirstTouches, classifyProspectDeletion } from './prospects'

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

describe('capFirstTouches', () => {
  const row = (id: number, contactedBefore: boolean) => ({ id, contactedBefore })

  it('keeps every follow-up and only the first `cap` first touches, in draw order', () => {
    const rows = [row(1, false), row(2, true), row(3, false), row(4, false), row(5, true)]
    expect(capFirstTouches(rows, 2).map((r) => r.id)).toEqual([1, 2, 3, 5])
    expect(capFirstTouches(rows, 0).map((r) => r.id)).toEqual([2, 5])
  })
})
