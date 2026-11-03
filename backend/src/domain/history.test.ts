import { describe, it, expect } from 'vitest'
import { buildActivityDays, buildHistory, historyLine, historySince, type HistoryOutcomes } from './history'
import type { LoggedChange } from './loop/change'
import type { Evidence } from './loop/evidence'
import type { ProposedChange } from './loop/proposal'

describe('buildActivityDays', () => {
  const reply = (responseType: 'reply' | 'rejection' | 'bounce' | 'meeting_request', sentiment: 'positive' | 'neutral' | 'negative') =>
    ({ kind: 'reply' as const, responseType, sentiment, reason: null })

  it('puts the day\'s work and what arrived that day on one row, each send once by its strongest', () => {
    const [day] = buildActivityDays({
      research: [{ day: '2026-11-01', researched: 12, notFit: 3, noContact: 2 }],
      sends: [{ day: '2026-11-01', contacted: 7, followUps: 2 }],
      reactions: [
        { day: '2026-11-01', outreachLogId: 1, reaction: reply('reply', 'neutral') },
        { day: '2026-11-01', outreachLogId: 1, reaction: reply('meeting_request', 'positive') },
        { day: '2026-11-01', outreachLogId: 2, reaction: reply('rejection', 'negative') },
        { day: '2026-11-01', outreachLogId: 3, reaction: reply('bounce', 'neutral') },
      ],
    })
    expect(day).toEqual({ date: '2026-11-01', researched: 12, notFit: 3, noContact: 2, contacted: 7, followUps: 2, positive: 1, interested: 1, declined: 1, bounced: 1 })
  })

  it('counts an opt-out as a no, with or without a reply', () => {
    const [day] = buildActivityDays({ research: [], sends: [], reactions: [{ day: '2026-11-02', outreachLogId: 9, reaction: { kind: 'inquiry', outcome: 'unsubscribed' } }] })
    expect(day?.declined).toBe(1)
  })

  it('gives a day with only replies a row', () => {
    const days = buildActivityDays({ research: [], sends: [], reactions: [{ day: '2026-11-02', outreachLogId: 9, reaction: reply('reply', 'neutral') }] })
    expect(days.map((d) => [d.date, d.interested, d.positive])).toEqual([['2026-11-02', 1, 0]])
  })
})

describe('buildHistory', () => {
  const evidence = (sends: number, positive: number, interested: number): Evidence =>
    ({ sends, trials: sends, rewardSum: 0, replied: interested, positive, interested, declined: 0, reasons: {}, bounced: 0, bounceable: 0 })
  const firstEdit = new Date('2026-10-01T09:00:00Z')
  const secondEdit = new Date('2026-10-10T17:00:00Z')
  const outcomes: HistoryOutcomes = {
    variants: new Map([['roi', evidence(152, 2, 12)]]),
    strategies: new Map([['yc', evidence(30, 0, 1)]]),
    found: new Map([['yc', { registered: 40, unqualified: 6, noContact: 4 }]]),
    frames: [{ start: null, trials: 1240.2, positive: 2 }, { start: { day: '2026-10-19', by: 'ace', reason: null }, trials: 41.6, positive: 1 }],
    sendsBetween: (from, to) => (from === firstEdit && to === secondEdit ? evidence(8, 0, 1) : from === secondEdit && to === null ? evidence(20, 1, 3) : evidence(0, 0, 0)),
  }
  const row = (text: string, rows: ReturnType<typeof buildHistory>) => rows.find((r) => r.text.includes(text))

  const variants = [{ variantId: 'roi', label: 'ROI focus' }]
  const rowsOf = (changes: LoggedChange[]) => buildHistory(changes, variants, [], [], outcomes)

  it('says who decided, and puts an option\'s whole life on the row that started it', () => {
    const rows = rowsOf([
      { day: '2026-10-20', actor: 'user', target: 'variant', optionId: 'roi', op: 'add', reason: 'asked for it', evidence: null },
      { day: '2026-10-19', actor: 'ace', target: 'strategy', optionId: 'yc', op: 'add', reason: null, evidence: { signals: ['replies', 'declines'] } },
      { day: '2026-10-18', actor: 'ace', target: 'strategy', optionId: 'yc', op: 'update', reason: null, evidence: null },
    ])
    expect(row('ROI focus', rows)).toMatchObject({ who: 'You', notes: ['asked for it'], result: '152 sends · 2 positive · 12 with interest', learned: false })
    expect(row('Started searching via', rows)).toMatchObject({
      who: 'Ace',
      notes: ['On reply rates, the noes'],
      result: "40 found · 6 didn't fit · 4 with no way to reach them · 30 sends · 1 with interest",
      learned: true,
    })
    expect(row('Changed the search', rows)?.result).toBeNull()
  })

  it('credits the rule with its evidence, as learned, naming only an angle by its label', () => {
    const rows = rowsOf([
      { day: '2026-10-20', actor: 'rule', target: 'variant', optionId: 'roi', op: 'archive', reason: 'lost', evidence: { pBeatsLeader: 0.02, n: 61 } },
      { day: '2026-10-19', actor: 'rule', target: 'strategy', optionId: 'roi', op: 'restore', evidence: null },
    ])
    expect(rows[0]).toMatchObject({ who: 'Rule', text: 'Retired “ROI focus”: a stronger angle won', notes: ['Win chance 2% · 61 sends'], learned: true })
    expect(rows[1]).toMatchObject({ who: 'Rule', text: 'Resumed searching via “roi”: its results caught up', notes: [], learned: true })
  })

  it('counts a strategy edit only until the next one, and states a frame against the one before', () => {
    const rows = rowsOf([
      { day: '2026-10-19', actor: 'ace', target: 'frame', reason: 'no positive in 120 trials', evidence: { signals: ['replies'] } },
      { day: '2026-10-10', at: secondEdit, actor: 'user', target: 'sales_strategy', reason: null, evidence: null },
      { day: '2026-10-01', at: firstEdit, actor: 'ace', target: 'sales_strategy', reason: null, evidence: null },
    ])
    expect(rows.map((r) => r.result)).toEqual([
      '1 positive of 42 counted (2.4%) · The frame before: 2 positive of 1240 counted (0.2%)',
      'Since then: 20 sends · 1 positive · 3 with interest',
      'Since then: 8 sends · 1 with interest',
    ])
  })

  it('orders a day as the log\'s changes, then proposals, then its work', () => {
    const change: ProposedChange = { kind: 'add-means', strategy: 'wantedly', instruction: 'Add Wantedly' }
    const rows = buildHistory(
      [{ day: '2026-10-20', actor: 'user', target: 'settings', diff: { outboundChannels: { from: ['email'], to: ['email', 'form'] } }, reason: 'asked', evidence: null }],
      variants,
      [{ title: 'Add Wantedly', status: 'pending', change, createdAt: new Date('2026-10-20T00:30:00Z') }],
      [{ date: '2026-10-20', researched: 2, notFit: 1, noContact: 0, contacted: 3, followUps: 1, positive: 1, interested: 2, declined: 1, bounced: 0 }],
      outcomes,
    )
    expect(rows.map((r) => r.who)).toEqual(['You', 'Ace', null])
    expect(rows[0]?.notes.at(-1)).toBe('asked')
    expect(rows[1]?.result).toBe('Waiting for you to set it up')
    expect(rows[2]).toMatchObject({ text: "Looked at 2 companies · 1 didn't fit · Contacted 3 · 1 follow-up", result: '1 positive · 1 with interest · 1 said no' })
  })
})

describe('historySince', () => {
  it('starts at the top of a UTC day, across a month', () => {
    expect(historySince(1, new Date('2026-11-01T12:30:00Z')).toISOString()).toBe('2026-10-31T00:00:00.000Z')
  })
})

describe('historyLine', () => {
  it('writes a row as one line with who, what, why and what came of it', () => {
    expect(historyLine({ date: '2026-10-20', who: 'You', text: 'Changed how Ace reaches out', notes: ['Follow-ups: off → on', 'asked'], result: null, learned: false })).toBe(
      '2026-10-20 You: Changed how Ace reaches out — Follow-ups: off → on — asked',
    )
    expect(historyLine({ date: '2026-10-20', who: null, text: 'Contacted 3', notes: [], result: '1 positive', learned: false })).toBe('2026-10-20 Contacted 3 — 1 positive')
  })
})
