import { describe, expect, it } from 'vitest'
import { draftReviewSection, type DraftReviewEntry } from './draft-review'

const base = { channel: 'email' as const, prospectName: 'Harbor Dental', industry: 'healthcare', agentSubject: 'Quick idea', agentBody: 'Hi Dana,\nWe cut no-shows.\n---\nNorthwind Inc, 1 Main St' }

const edited: DraftReviewEntry = { ...base, verdict: 'edited', sentSubject: 'Quick idea', sentBody: 'Hi Dana,\nFewer no-shows, no new software.\n---\nNorthwind Inc, 1 Main St' }
const wrongProspect: DraftReviewEntry = { ...base, verdict: 'wrong_prospect', note: 'we do not sell\n- to agencies' }

describe('draftReviewSection', () => {
  it('shows an edit as the agent text against what the person sent, without the appended footer', () => {
    const section = draftReviewSection([edited])
    expect(section).toContain('We cut no-shows.')
    expect(section).toContain('Fewer no-shows, no new software.')
    expect(section).not.toContain('1 Main St')
  })

  it('keeps a multi-line note inside its one list item', () => {
    expect(draftReviewSection([wrongProspect])).toBe('- Discarded the draft to Harbor Dental (healthcare) — wrong prospect: "we do not sell - to agencies".')
  })

  it('is null when nothing was corrected', () => {
    expect(draftReviewSection([])).toBeNull()
  })
})
