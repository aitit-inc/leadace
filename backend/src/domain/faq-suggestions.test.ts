import { describe, it, expect } from 'vitest'
import { extractFaqQuestions, FAQ_SUGGESTIONS_MAX } from './faq-suggestions'

describe('extractFaqQuestions', () => {
  it('returns [] for a null brief', () => {
    expect(extractFaqQuestions(null)).toEqual([])
  })

  it('extracts Q: lines and ignores everything else', () => {
    const brief = [
      'We sell widgets.',
      'Q: What does it cost?',
      'A: It depends.',
      'Q: Do you offer trials?',
    ].join('\n')
    expect(extractFaqQuestions(brief)).toEqual(['What does it cost?', 'Do you offer trials?'])
  })

  it('is case-sensitive (lowercase q: is not a question)', () => {
    expect(extractFaqQuestions('q: ignored\nQ: kept')).toEqual(['kept'])
  })

  it('tolerates leading whitespace before Q:', () => {
    expect(extractFaqQuestions('\t  Q: indented?')).toEqual(['indented?'])
  })

  it('caps the number of questions', () => {
    const brief = Array.from({ length: FAQ_SUGGESTIONS_MAX + 3 }, (_, i) => `Q: q${i}`).join('\n')
    expect(extractFaqQuestions(brief)).toHaveLength(FAQ_SUGGESTIONS_MAX)
    expect(extractFaqQuestions(brief, 2)).toHaveLength(2)
  })
})
