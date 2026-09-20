import { describe, expect, it } from 'vitest'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { contextOf, inReadingOrder, termsChanged, toItems } from './agent'
import type { MessageView } from './threads'

let nextId = 1
const msg = (content: MessageView['content'], readAfter: number | null = 0): MessageView => ({ id: nextId++, role: content.role, content, readAfter, createdAt: new Date(0) })
const call = (id: string) => ({ functionCall: { id, name: 'list_projects', args: {} } })
const answer = (id: string) => ({ functionResponse: { id, name: 'list_projects', response: { result: 'ok' } } })

function shape(item: ResponseInputItem): string {
  if ('type' in item && item.type === 'function_call') return `call ${item.call_id}`
  if ('type' in item && item.type === 'function_call_output') return `output ${item.call_id}`
  if ('role' in item) return item.role
  return 'other'
}
const outputOf = (items: ResponseInputItem[], callId: string) =>
  items.flatMap((i) => ('type' in i && i.type === 'function_call_output' && i.call_id === callId ? [JSON.parse(i.output as string) as Record<string, unknown>] : []))[0]

describe('toItems', () => {
  it('keeps an answered exchange verbatim', () => {
    const items = toItems([
      msg({ role: 'user', parts: [{ text: 'hi' }] }),
      msg({ role: 'model', parts: [{ text: 'Looking.' }, call('c1')] }),
      msg({ role: 'tool', parts: [answer('c1')] }),
    ])
    expect(items.map(shape)).toEqual(['user', 'assistant', 'call c1', 'output c1'])
    expect(outputOf(items, 'c1')).toEqual({ result: 'ok' })
  })

  it('answers a call the turn never completed with an error output', () => {
    const items = toItems([msg({ role: 'model', parts: [call('c1'), call('c2')] }), msg({ role: 'user', parts: [{ text: 'still there?' }] })])
    expect(items.map(shape)).toEqual(['call c1', 'call c2', 'output c1', 'output c2', 'user'])
    expect(outputOf(items, 'c1')).toHaveProperty('error')
  })

  it('fills in only the calls a partial tool message left out', () => {
    const items = toItems([msg({ role: 'model', parts: [call('c1'), call('c2')] }), msg({ role: 'tool', parts: [answer('c2')] })])
    expect(items.map(shape)).toEqual(['call c1', 'call c2', 'output c2', 'output c1'])
  })

  it('moves a job notice that landed between a call and its answer after the answer', () => {
    const items = toItems([
      msg({ role: 'model', parts: [call('c1')] }),
      msg({ role: 'job', jobId: 'j1', kind: 'draft', status: 'succeeded', summary: 'done' }),
      msg({ role: 'tool', parts: [answer('c1')] }),
    ])
    expect(items.map(shape)).toEqual(['call c1', 'output c1', 'user'])
    expect(outputOf(items, 'c1')).toEqual({ result: 'ok' })
  })

  it('answers a call cut off by the end of the window', () => {
    expect(toItems([msg({ role: 'model', parts: [call('c1')] })]).map(shape)).toEqual(['call c1', 'output c1'])
  })
})

describe('toItems attachments', () => {
  const file = (expiresAt: string) => ({ id: 'a'.repeat(21), fileId: 'file_1', expiresAt, name: 'deck.pdf', kind: 'document' as const, size: 10 })
  const sent = (expiresAt: string) => msg({ role: 'user', parts: [{ file: file(expiresAt) }, { text: 'read this' }] })

  it('hands the model the provider\'s copy', () => {
    const items = toItems([sent('2026-10-01T00:00:00.000Z')], null, new Date('2026-09-20'))
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }, { type: 'input_text', text: 'read this' }] },
    ])
  })

  it('says a file is gone once the provider has dropped it', () => {
    const items = toItems([sent('2026-08-01T00:00:00.000Z')], null, new Date('2026-09-20'))
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '[attached file deck.pdf — no longer available to read]' }, { type: 'input_text', text: 'read this' }] },
    ])
  })
})

describe('contextOf', () => {
  it('sends the whole thread when no stored response holds it', () => {
    const context = contextOf([msg({ role: 'user', parts: [{ text: 'hi' }] }), msg({ role: 'model', parts: [{ text: 'Hello.' }] })])
    expect(context.previousResponseId).toBeNull()
    expect(context.input.map(shape)).toEqual(['user', 'assistant'])
  })

  it('continues the last stored response with only what came after it', () => {
    const context = contextOf([
      msg({ role: 'user', parts: [{ text: 'hi' }] }),
      msg({ role: 'model', parts: [{ text: 'Hello.' }], responseId: 'resp_1' }),
      msg({ role: 'user', parts: [{ text: 'list projects' }] }),
      msg({ role: 'model', parts: [call('c1')], responseId: 'resp_2' }),
      msg({ role: 'tool', parts: [answer('c1')] }),
    ])
    expect(context.previousResponseId).toBe('resp_2')
    expect(context.input.map(shape)).toEqual(['output c1'])
  })

  it('answers the continued response\'s calls the person declined by moving on', () => {
    const context = contextOf([msg({ role: 'model', parts: [call('c1')], responseId: 'resp_1' }), msg({ role: 'user', parts: [{ text: 'never mind' }] })])
    expect(context.input.map(shape)).toEqual(['output c1', 'user'])
  })

  it('keeps an answer stopped mid-stream, which no stored response holds', () => {
    const context = contextOf([
      msg({ role: 'model', parts: [{ text: 'Hello.' }], responseId: 'resp_1' }),
      msg({ role: 'user', parts: [{ text: 'tell me more' }] }),
      msg({ role: 'model', parts: [{ text: 'Well, fir' }] }),
      msg({ role: 'user', parts: [{ text: 'stop, shorter' }] }),
    ])
    expect(context.previousResponseId).toBe('resp_1')
    expect(context.input.map(shape)).toEqual(['user', 'assistant', 'user'])
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
    expect(toItems(ordered).at(-1)).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'and the drafts?' }] })
  })

  it('keeps that message where it was read in every later turn', () => {
    const first = person('list the documents')
    const second = person('and the drafts?')
    const firstReply = reply('Here they are.')
    const asked = msg({ role: 'model', parts: [call('c2')] })
    const answered = msg({ role: 'tool', parts: [answer('c2')] })
    const secondReply = reply('Two drafts are waiting.')
    second.readAfter = firstReply.id
    const items = toItems(inReadingOrder([first, second, firstReply, asked, answered, secondReply]))
    expect(items.map(shape)).toEqual(['user', 'assistant', 'user', 'call c2', 'output c2', 'assistant'])
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
