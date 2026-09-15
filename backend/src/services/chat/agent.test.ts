import { describe, expect, it } from 'vitest'
import { inReadingOrder, termsChanged, toContents } from './agent'
import type { MessageView } from './threads'

let nextId = 1
const msg = (content: MessageView['content'], readAfter: number | null = 0): MessageView => ({ id: nextId++, role: content.role, content, readAfter, createdAt: new Date(0) })
const call = (id: string) => ({ functionCall: { id, name: 'list_projects', args: {} } })
const answer = (id: string) => ({ functionResponse: { id, name: 'list_projects', response: { result: 'ok' } } })

describe('toContents', () => {
  it('keeps an answered exchange verbatim', () => {
    const contents = toContents([
      msg({ role: 'user', parts: [{ text: 'hi' }] }),
      msg({ role: 'model', parts: [call('c1')] }),
      msg({ role: 'tool', parts: [answer('c1')] }),
    ])
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2]?.parts).toEqual([answer('c1')])
  })

  it('answers a call the turn never completed with an error response', () => {
    const contents = toContents([
      msg({ role: 'model', parts: [call('c1'), call('c2')] }),
      msg({ role: 'user', parts: [{ text: 'still there?' }] }),
    ])
    expect(contents.map((c) => c.role)).toEqual(['model', 'user', 'user'])
    expect(contents[1]?.parts?.map((p) => p.functionResponse?.id)).toEqual(['c1', 'c2'])
    expect(contents[1]?.parts?.[0]?.functionResponse?.response).toHaveProperty('error')
  })

  it('fills in only the calls a partial tool message left out', () => {
    const contents = toContents([msg({ role: 'model', parts: [call('c1'), call('c2')] }), msg({ role: 'tool', parts: [answer('c2')] })])
    expect(contents[1]?.parts?.map((p) => p.functionResponse?.id)).toEqual(['c2', 'c1'])
  })

  it('moves a job notice that landed between a call and its answer after the answer', () => {
    const contents = toContents([
      msg({ role: 'model', parts: [call('c1')] }),
      msg({ role: 'job', jobId: 'j1', kind: 'draft', status: 'succeeded', summary: 'done' }),
      msg({ role: 'tool', parts: [answer('c1')] }),
    ])
    expect(contents.map((c) => c.role)).toEqual(['model', 'user', 'user'])
    expect(contents[1]?.parts).toEqual([answer('c1')])
    expect(contents[2]?.parts?.[0]?.text).toContain('Job draft j1')
  })

  it('answers a call cut off by the end of the window', () => {
    const contents = toContents([msg({ role: 'model', parts: [call('c1')] })])
    expect(contents).toHaveLength(2)
    expect(contents[1]?.parts?.[0]?.functionResponse?.id).toBe('c1')
  })
})

describe('inReadingOrder', () => {
  const person = (text: string, readAfter: number | null = 0) => msg({ role: 'user', parts: [{ text }] }, readAfter)
  const reply = (text: string) => msg({ role: 'model', parts: [{ text }] })

  it('puts a message the agent has not read after the answer it arrived during, so the model answers it', () => {
    const first = person('list the documents')
    const second = person('and the drafts?', null)
    const firstReply = reply('Here they are.')
    const ordered = inReadingOrder([first, second, firstReply])
    expect(ordered).toEqual([first, firstReply, second])
    expect(toContents(ordered).at(-1)?.parts).toEqual([{ text: 'and the drafts?' }])
  })

  it('keeps that message where it was read in every later turn', () => {
    const first = person('list the documents')
    const second = person('and the drafts?')
    const firstReply = reply('Here they are.')
    const asked = msg({ role: 'model', parts: [call('c2')] })
    const answered = msg({ role: 'tool', parts: [answer('c2')] })
    const secondReply = reply('Two drafts are waiting.')
    second.readAfter = firstReply.id
    const contents = toContents(inReadingOrder([first, second, firstReply, asked, answered, secondReply]))
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user', 'model'])
  })

  it('leaves rows read where they landed in place', () => {
    const messages = [person('go'), msg({ role: 'job', jobId: 'j1', kind: 'draft', status: 'succeeded', summary: 'done' }), reply('ok')]
    expect(inReadingOrder(messages)).toEqual(messages)
  })
})

describe('termsChanged', () => {
  const card = { title: "Run today's cycle", facts: [], confirmLabel: 'Draft up to 10 messages' }
  it('re-asks when the project started sending under a draft approval', () => {
    expect(termsChanged(card, { ...card, confirmLabel: 'Send up to 10 emails', warning: 'Sent email cannot be recalled.' })).toBe(true)
  })
  it('does not re-ask because a number moved', () => {
    expect(termsChanged(card, { ...card, facts: [{ label: 'Outreach quota', value: '86 of 100 left this month' }] })).toBe(false)
  })
})
