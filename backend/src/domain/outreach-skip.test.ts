import { describe, it, expect } from 'vitest'
import { skipReasonEnum } from '../db/schema'
import { SKIP_REASON_LABELS, buildSkipAuditBody } from './outreach-skip'

describe('buildSkipAuditBody', () => {
  it('renders the reason label without a note', () => {
    expect(buildSkipAuditBody('bad_timing')).toBe('Skipped: bad timing')
    expect(buildSkipAuditBody('no_fresh_material')).toBe(
      'Skipped: no fresh material for re-approach',
    )
  })

  it('appends a trimmed note after an em dash', () => {
    expect(buildSkipAuditBody('bad_timing', 'layoffs ongoing')).toBe(
      'Skipped: bad timing — layoffs ongoing',
    )
    expect(buildSkipAuditBody('other', '  paused by user  ')).toBe(
      'Skipped: other — paused by user',
    )
  })

  it('ignores empty / whitespace-only notes', () => {
    expect(buildSkipAuditBody('bad_timing', '')).toBe('Skipped: bad timing')
    expect(buildSkipAuditBody('bad_timing', '   ')).toBe('Skipped: bad timing')
    expect(buildSkipAuditBody('bad_timing', null)).toBe('Skipped: bad timing')
  })

  it('has a label for every skip_reason enum value', () => {
    for (const reason of skipReasonEnum.enumValues) {
      expect(SKIP_REASON_LABELS[reason]).toBeTruthy()
    }
  })
})
