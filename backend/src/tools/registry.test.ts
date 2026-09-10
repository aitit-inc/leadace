import { describe, expect, it } from 'vitest'
import { parseToolArgs } from './declarations'
import { buildToolRegistry, startJobConfirmSummary, type OutboundPreview, type ToolCtx } from './registry'

const byName = new Map(buildToolRegistry().map((t) => [t.name, t]))

// Every preview read fails: a card that cannot state the facts must still
// hold the gate.
const blindCtx: ToolCtx = { callApi: async () => ({ ok: false, status: 500, data: null }) }

const gate = async (name: string, args: Record<string, unknown>) => {
  const tool = byName.get(name)!
  if (!tool.confirm) return null
  const parsed = parseToolArgs(tool, args)
  return parsed.ok ? await tool.confirm(parsed.value, blindCtx) : null
}

describe('confirmation gate', () => {
  it('gates tools that send, delete, or reshape the workspace', async () => {
    expect(await gate('send_email_and_record', { projectId: 'p', prospectId: 1, subject: 's', body: 'b' })).not.toBeNull()
    expect(await gate('delete_prospects', { prospectIds: [1] })).not.toBeNull()
    expect(await gate('delete_project', { projectId: 'p' })).not.toBeNull()
  })
  it('gates start_job only for kinds that can send', async () => {
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'send', draftIds: [1] } })).not.toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'daily_cycle' } })).not.toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'draft', count: 5 } })).not.toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'discover', count: 10 } })).toBeNull()
  })
  it('gates do-not-contact only where the consequence is (clearing it)', async () => {
    expect(await gate('set_prospect_do_not_contact', { prospectId: 1, doNotContact: false })).not.toBeNull()
    expect(await gate('set_prospect_do_not_contact', { prospectId: 1, doNotContact: true })).toBeNull()
  })
  it('does not gate a call whose arguments will not execute', async () => {
    expect(await gate('start_job', {})).toBeNull()
  })
  it('gates a status change only where it puts someone back on the list', async () => {
    // The read fails under blindCtx, so the current status is unknown: a move
    // into a reachable status still asks.
    expect(await gate('update_prospect_status', { projectId: 'p', prospectId: 1, status: 'deferred' })).not.toBeNull()
    expect(await gate('update_prospect_status', { projectId: 'p', prospectId: 1, status: 'contacted' })).toBeNull()
  })
  it('leaves reads alone', async () => {
    expect(await gate('list_projects', {})).toBeNull()
    expect(await gate('get_document', { projectId: 'p', slug: 'business' })).toBeNull()
  })
})

const preview = (outboundMode: 'send' | 'draft'): OutboundPreview => ({
  outboundMode,
  reachable: 12,
  quota: { plan: 'starter', kind: 'capped', used: 13, limit: 100, remaining: 87, bindingConstraint: 'monthly' },
  mailbox: { email: 'me@example.com', remaining: 9 },
  blocked: null,
})

const factValue = (summary: { facts: Array<{ label: string; value: string }> }, label: string) =>
  summary.facts.find((f) => f.label === label)?.value ?? ''

describe('start_job approval card', () => {
  it('says mail leaves when the project sends', () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', preview('send'))!
    expect(factValue(summary, 'What happens')).toContain('sent')
    expect(factValue(summary, 'How many')).toBe('up to 10 prospects')
    expect(factValue(summary, 'From')).toBe('me@example.com')
    expect(summary.confirmLabel).toBe('Send up to 10 emails')
    expect(summary.warning).toContain('cannot be recalled')
  })
  it('says nothing is sent when the project drafts', () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', preview('draft'))!
    expect(factValue(summary, 'What happens')).toContain('nothing is sent')
    expect(summary.confirmLabel).toBe('Draft up to 10 messages')
    expect(summary.warning).toBeUndefined()
  })
  it('never claims a direction it could not read', () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', null)!
    expect(factValue(summary, 'What happens')).toContain('outbound mode decides')
    expect(summary.confirmLabel).toBe('Start')
  })
  it('sends the given drafts whatever the mode says', () => {
    const summary = startJobConfirmSummary({ kind: 'send', draftIds: [1, 2, 3] }, 'Acme', preview('draft'))!
    expect(factValue(summary, 'How many')).toBe('3 drafts')
    expect(summary.confirmLabel).toBe('Send 3 emails')
  })
})
