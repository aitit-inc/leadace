import { describe, expect, it } from 'vitest'
import { citationsOf } from './gemini'

describe('citationsOf', () => {
  const pages = ['https://a.example/1', null, 'https://b.example/2', 'https://a.example/1']

  it('merges the pages of a passage cited more than once, without duplicates', () => {
    expect(citationsOf([
      { passage: 'J PREP opens a Kojimachi school', chunks: [0] },
      { passage: 'J PREP opens a Kojimachi school', chunks: [2, 3] },
    ], pages)).toEqual([{ passage: 'J PREP opens a Kojimachi school', pages: ['https://a.example/1', 'https://b.example/2'] }])
  })

  it('leaves out a passage whose results resolved to no page', () => {
    expect(citationsOf([
      { passage: 'unresolved', chunks: [1] },
      { passage: 'out of range', chunks: [9] },
      { passage: '', chunks: [0] },
      { passage: 'kept', chunks: [1, 2] },
    ], pages)).toEqual([{ passage: 'kept', pages: ['https://b.example/2'] }])
  })
})
