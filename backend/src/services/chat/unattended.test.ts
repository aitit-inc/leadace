import { describe, expect, it } from 'vitest'
import type { ToolExecutor } from './agent'
import { unattendedTools } from './unattended'

// Gated in the attended chat. `set_prospect_do_not_contact` is the shape that
// matters most here: its card is raised for some arguments and not others.
const GATED = new Set(['send_email_and_record', 'delete_prospects', 'set_prospect_do_not_contact', 'set_schedule', 'start_job'])

function attended(): { tools: ToolExecutor; ran: string[] } {
  const ran: string[] = []
  const tools: ToolExecutor = {
    declarations: [],
    confirmSummary: (name, args) => {
      if (!GATED.has(name)) return null
      // Mirrors the real callbacks: no card when the change is the harmless
      // direction (setting do-not-contact, turning a schedule off).
      if (name === 'set_prospect_do_not_contact' && args['doNotContact'] === true) return null
      if (name === 'set_schedule' && args['enabled'] === false) return null
      return { title: name, facts: [], confirmLabel: 'Go' }
    },
    isReadOnly: (name) => name.startsWith('list_'),
    isGated: (name) => GATED.has(name),
    execute: (name) => {
      ran.push(name)
      return Promise.resolve({ ok: true, text: 'done' })
    },
  }
  return { tools, ran }
}

describe('unattendedTools', () => {
  it('runs a tool no one has to approve', async () => {
    const { tools, ran } = attended()
    await expect(unattendedTools(tools).execute('list_drafts', {})).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['list_drafts'])
  })

  it('refuses a gated tool instead of running it unapproved', async () => {
    const { tools, ran } = attended()
    const result = await unattendedTools(tools).execute('send_email_and_record', { prospectId: 1 })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("needs a person's approval")
    expect(ran).toEqual([])
  })

  it('refuses a gated tool whose card this call would not raise', async () => {
    const { tools, ran } = attended()
    await expect(unattendedTools(tools).execute('set_prospect_do_not_contact', { prospectId: 1, doNotContact: true })).resolves.toMatchObject({ ok: false })
    await expect(unattendedTools(tools).execute('set_schedule', { scheduleId: 's1', enabled: false })).resolves.toMatchObject({ ok: false })
    expect(ran).toEqual([])
  })

  it('starts a job, the one action registering a schedule authorizes', async () => {
    const { tools, ran } = attended()
    await expect(unattendedTools(tools).execute('start_job', { params: { kind: 'daily_cycle', outboundCount: 30 } })).resolves.toMatchObject({ ok: true })
    expect(ran).toEqual(['start_job'])
  })

  it('refuses a send job — those drafts were written for a person to approve', async () => {
    const { tools, ran } = attended()
    const result = await unattendedTools(tools).execute('start_job', { params: { kind: 'send', draftIds: [1, 2] } })
    expect(result.ok).toBe(false)
    expect(ran).toEqual([])
  })

  it('holds nothing for approval, so a run never parks on a card', () => {
    const { tools } = attended()
    expect(unattendedTools(tools).confirmSummary('send_email_and_record', {})).toBeNull()
  })
})
