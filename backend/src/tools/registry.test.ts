import { describe, expect, it } from 'vitest'
import { parseToolArgs } from './declarations'
import { buildToolRegistry } from './registry'

const byName = new Map(buildToolRegistry().map((t) => [t.name, t]))
const confirms = (name: string, args: Record<string, unknown>) => {
  const tool = byName.get(name)!
  const parsed = parseToolArgs(tool, args)
  return parsed.ok && tool.confirm(parsed.value)
}

describe('confirmation gate', () => {
  it('gates tools that send, delete, or reshape the workspace', () => {
    expect(confirms('send_email_and_record', { projectId: 'p', prospectId: 1, subject: 's', body: 'b' })).toBe(true)
    expect(confirms('delete_prospects', { prospectIds: [1] })).toBe(true)
    expect(confirms('delete_project', { projectId: 'p' })).toBe(true)
  })
  it('gates start_job only for kinds that can send', () => {
    expect(confirms('start_job', { projectId: 'p', params: { kind: 'send', draftIds: [1] } })).toBe(true)
    expect(confirms('start_job', { projectId: 'p', params: { kind: 'daily_cycle' } })).toBe(true)
    expect(confirms('start_job', { projectId: 'p', params: { kind: 'draft', count: 5 } })).toBe(true)
    expect(confirms('start_job', { projectId: 'p', params: { kind: 'discover', count: 10 } })).toBe(false)
  })
  it('does not gate a call whose arguments will not execute', () => {
    expect(confirms('start_job', {})).toBe(false)
  })
  it('leaves reads alone', () => {
    expect(confirms('list_projects', {})).toBe(false)
    expect(confirms('get_document', { projectId: 'p', slug: 'business' })).toBe(false)
  })
})
