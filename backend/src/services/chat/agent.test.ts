import { describe, expect, it } from 'vitest'
import { toContents } from './agent'
import type { MessageView } from './threads'

let nextId = 1
const msg = (content: MessageView['content']): MessageView => ({ id: nextId++, role: content.role, content, createdAt: new Date(0) })
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
