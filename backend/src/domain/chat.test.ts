import { describe, expect, it } from 'vitest'
import { needsConfirmation } from './chat'

describe('needsConfirmation', () => {
  it('gates sends, deletions, and workspace-shaping writes', () => {
    expect(needsConfirmation('send_email_and_record', {})).toBe(true)
    expect(needsConfirmation('delete_prospects', {})).toBe(true)
    expect(needsConfirmation('apply_strategy_draft', {})).toBe(true)
  })
  it('gates only the job kinds that can send mail', () => {
    expect(needsConfirmation('start_job', { params: { kind: 'send' } })).toBe(true)
    expect(needsConfirmation('start_job', { params: { kind: 'daily_cycle' } })).toBe(true)
    expect(needsConfirmation('start_job', { params: { kind: 'draft' } })).toBe(true)
    expect(needsConfirmation('start_job', { params: { kind: 'discover' } })).toBe(false)
    expect(needsConfirmation('start_job', {})).toBe(false)
  })
  it('lets reads through', () => {
    expect(needsConfirmation('list_projects', {})).toBe(false)
    expect(needsConfirmation('get_document', {})).toBe(false)
  })
})
