import { describe, expect, it } from 'vitest'
import { parseToolArgs } from './declarations'
import { buildToolRegistry, startJobConfirmSummary, type OutboundPreview, type ToolCtx } from './registry'

const byName = new Map(buildToolRegistry().map((t) => [t.name, t]))

// Every preview read fails: a card that cannot state the facts must still
// hold the gate.
const blindCtx: ToolCtx = { callApi: async () => ({ ok: false, status: 500, data: null }) }

// Reads answer from these routes (by path prefix); the rest fail.
const seen = (routes: Record<string, unknown>): ToolCtx => ({
  callApi: async (_method, path) => {
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))
    return hit ? { ok: true, status: 200, data: hit[1] } : { ok: false, status: 404, data: null }
  },
})

const gate = async (name: string, args: Record<string, unknown>, personAsked = false, ctx: ToolCtx = blindCtx) => {
  const tool = byName.get(name)!
  if (!tool.confirm) return null
  const parsed = parseToolArgs(tool, args)
  return parsed.ok ? await tool.confirm(parsed.value, { ...ctx, personAsked }) : null
}

const reachable = (outboundMode: 'draft' | 'send') => seen({ '/projects/p/prospects/reachable': { total: 3, outboundMode, outboundBlocked: false } })
const mailbox = (pausedUntil: string | null) =>
  seen({ '/me/sending-identities': { identities: [{ identityId: 'i', fromEmail: 'a@b.example', dailyCapOverride: null, pausedUntil, sendRefusal: null, inboxTestHeld: false }] } })
const DRAFT = {
  targetLanguage: 'en',
  business: '# Business',
  salesStrategy: '# Sales strategy',
  discoveryStrategies: ['school-lists', 'job-boards', 'event-pages'].map((slug) => ({ slug, approach: 'Search there.' })),
  messageVariants: ['angle_a', 'angle_b', 'angle_c', 'angle_d'].map((variantId) => ({ variantId, subjectPattern: 'Hi {{org}}', bodyApproach: 'Short.', label: variantId })),
  inquiryChatBrief: 'What we do.',
  inquiryOneLiner: 'One line.',
  outboundChannels: ['email'],
}

describe('confirmation gate', () => {
  it('runs what the person asked for when it can be taken back, and still asks what cannot', async () => {
    const schedule = { projectId: 'p', prompt: 'Run today', timezone: 'UTC', hour: 9 }
    expect(await gate('set_schedule', schedule)).not.toBeNull()
    expect(await gate('set_schedule', schedule, true)).toBeNull()
    expect(await gate('delete_schedule', { scheduleId: 's' }, true)).toBeNull()
    // A cycle that only drafts runs; one that sends, or one whose mode cannot be read, asks.
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'daily_cycle' } }, true, reachable('draft'))).toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'daily_cycle' } }, true, reachable('send'))).not.toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'daily_cycle' } }, true)).not.toBeNull()
    expect(await gate('start_job', { projectId: 'p', params: { kind: 'send', draftIds: [1] } }, true, reachable('draft'))).not.toBeNull()
    // A first setup replaces nothing; over an existing one it asks.
    expect(await gate('apply_strategy_draft', { projectId: 'p', draft: DRAFT }, true, seen({ '/projects/p/documents': { documents: [] } }))).toBeNull()
    expect(await gate('apply_strategy_draft', { projectId: 'p', draft: DRAFT }, true, seen({ '/projects/p/documents': { documents: [{ slug: 'sales_strategy' }] } }))).not.toBeNull()
    expect(await gate('apply_strategy_draft', { projectId: 'p', draft: DRAFT }, false, seen({ '/projects/p/documents': { documents: [] } }))).not.toBeNull()
    expect(await gate('update_project_settings', { projectId: 'p', outboundMode: 'draft' }, true)).toBeNull()
    expect(await gate('update_project_settings', { projectId: 'p', outboundMode: 'send' }, true)).not.toBeNull()
    expect(await gate('update_project_settings', { projectId: 'p', senderDisplayName: 'Leo' }, true)).not.toBeNull()
    // A pause that starts or lengthens one runs; one in the past or shorter than the current asks.
    expect(await gate('update_mailbox_sending', { mailbox: 'a@b.example', pausedUntil: '2099-01-01T00:00:00Z' }, true, mailbox(null))).toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@b.example', pausedUntil: '2020-01-01T00:00:00Z' }, true, mailbox(null))).not.toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@b.example', pausedUntil: '2098-01-01T00:00:00Z' }, true, mailbox('2099-01-01T00:00:00Z'))).not.toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@b.example', pausedUntil: null }, true, mailbox('2099-01-01T00:00:00Z'))).not.toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@b.example', dailyCap: 50 }, true)).not.toBeNull()
    expect(await gate('send_email_and_record', { projectId: 'p', prospectId: 1, subject: 's', body: 'b' }, true)).not.toBeNull()
    expect(await gate('delete_prospects', { prospectIds: [1] }, true)).not.toBeNull()
    expect(await gate('set_prospect_do_not_contact', { prospectId: 1, doNotContact: false }, true)).not.toBeNull()
  })

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
  it('gates every change to a mailbox\'s sending controls, even when its state cannot be read', async () => {
    expect(await gate('update_mailbox_sending', { mailbox: 'a@example.com', dailyCap: 100 })).not.toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@example.com', resolveRefusal: true })).not.toBeNull()
    expect(await gate('update_mailbox_sending', { mailbox: 'a@example.com' })).toBeNull()
  })
  it('leaves reads alone', async () => {
    expect(await gate('list_projects', {})).toBeNull()
    expect(await gate('get_document', { projectId: 'p', slug: 'business' })).toBeNull()
  })
})

const preview = (outboundMode: 'send' | 'draft'): OutboundPreview => ({
  outboundMode,
  reachable: 12,
  quota: {
    plan: 'starter',
    kind: 'capped',
    window: 'monthly',
    credits: null,
    contacted: { used: 13, limit: 100, remaining: 87 },
    found: { used: 4, limit: 100, remaining: 96 },
  },
  mailbox: { next: 'me@example.com', remaining: 9 },
  blocked: null,
  dailyTarget: 14,
})

const factValue = (summary: { facts: Array<{ label: string; value: string }> }, label: string) =>
  summary.facts.find((f) => f.label === label)?.value ?? ''

describe('start_job approval card', () => {
  it('says mail leaves when the project sends', () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', preview('send'), [])!
    expect(factValue(summary, 'What happens')).toContain('sent')
    expect(factValue(summary, 'How many')).toBe('up to 10 new prospects, plus the follow-ups and re-approaches that are due')
    expect(factValue(summary, 'From')).toBe('me@example.com')
    expect(summary.confirmLabel).toBe('Send to up to 10 new prospects')
    expect(summary.warning).toContain('cannot be recalled')
  })
  it('asks nothing when the project holds what the job writes for review', () => {
    expect(startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', preview('draft'), [])).toBeNull()
    expect(startJobConfirmSummary({ kind: 'draft', count: 5 }, 'Acme', preview('draft'), [])).toBeNull()
  })
  it('never claims a direction it could not read', () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle', outboundCount: 10 }, 'Acme', null, [])!
    expect(factValue(summary, 'What happens')).toContain('outbound mode decides')
    expect(summary.confirmLabel).toBe('Start')
  })
  it("shows the project's daily number when the run names none", () => {
    const summary = startJobConfirmSummary({ kind: 'daily_cycle' }, 'Acme', preview('send'), [])!
    expect(factValue(summary, 'How many')).toBe("the project's daily number of new prospects (14 as of now), plus the follow-ups and re-approaches that are due")
    expect(summary.confirmLabel).toBe("Send to today's new prospects")
    const unread = startJobConfirmSummary({ kind: 'daily_cycle' }, 'Acme', null, [])!
    expect(factValue(unread, 'How many')).toBe("the project's daily number of new prospects, plus the follow-ups and re-approaches that are due")
  })
  it('sends the given drafts whatever the mode says, showing each email', () => {
    const drafts = [
      { prospectName: 'Dana', prospectEmail: 'dana@example.com', subject: 'Hello', body: 'First body' },
      { prospectName: 'Miles', prospectEmail: 'miles@example.com', subject: 'Hi', body: 'Second body' },
    ]
    const summary = startJobConfirmSummary({ kind: 'send', draftIds: [1, 2, 3] }, 'Acme', preview('draft'), drafts)!
    expect(factValue(summary, 'How many')).toBe('3 drafts')
    expect(summary.confirmLabel).toBe('Send 3 emails')
    expect(summary.body).toContain('To: Dana <dana@example.com>\nSubject: Hello\n\nFirst body')
    expect(summary.body).toContain('Second body')
  })
})
