import { describe, it, expect } from 'vitest'
import { extractCandidateText, type RawGeminiResponse } from './gemini'

describe('extractCandidateText', () => {
  it('joins split text parts and ignores grounding metadata', () => {
    const data: RawGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: '{"highlights":["Raised Series B' }, { text: ' on 2026-05-20"]}' }],
          },
          groundingMetadata: {
            searchEntryPoint: { renderedContent: '<div>…</div>' },
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
          },
        },
      ],
    }
    expect(extractCandidateText(data)).toBe('{"highlights":["Raised Series B on 2026-05-20"]}')
  })

  it('returns null when there are no candidates', () => {
    expect(extractCandidateText({})).toBeNull()
    expect(extractCandidateText({ candidates: [] })).toBeNull()
  })

  it('returns null when the candidate has no text parts (e.g. safety stop)', () => {
    expect(extractCandidateText({ candidates: [{ content: { parts: [] } }] })).toBeNull()
    expect(extractCandidateText({ candidates: [{ content: { parts: [{ text: '  ' }] } }] })).toBeNull()
  })
})
