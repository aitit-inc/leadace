import { describe, it, expect } from 'vitest'
import { sentimentForResponse } from './responses'

describe('sentimentForResponse', () => {
  it('records every rejection as negative, whatever the caller read', () => {
    for (const sentiment of ['positive', 'neutral', 'negative'] as const) {
      expect(sentimentForResponse({ responseType: 'rejection', sentiment })).toBe('negative')
    }
  })

  it('keeps the caller sentiment on every other type', () => {
    for (const responseType of ['reply', 'meeting_request', 'bounce', 'auto_reply'] as const) {
      expect(sentimentForResponse({ responseType, sentiment: 'neutral' })).toBe('neutral')
      expect(sentimentForResponse({ responseType, sentiment: 'positive' })).toBe('positive')
    }
  })
})
