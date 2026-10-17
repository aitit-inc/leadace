import { describe, it, expect } from 'vitest'
import { toReplyClassification } from './reply-classify'

describe('toReplyClassification', () => {
  it('carries the reason and the trimmed quote of a rejection', () => {
    expect(
      toReplyClassification({ sentiment: 'negative', responseType: 'rejection', rejectionReason: 'budget', rejectionQuote: '  no budget this year ' }),
    ).toEqual({ sentiment: 'negative', responseType: 'rejection', rejection: { reason: 'budget', quote: 'no budget this year' } })
  })

  it('falls back to other and a null quote when the rejection gives neither', () => {
    expect(
      toReplyClassification({ sentiment: 'negative', responseType: 'rejection', rejectionReason: null, rejectionQuote: '   ' }),
    ).toEqual({ sentiment: 'negative', responseType: 'rejection', rejection: { reason: 'other', quote: null } })
  })

  it('caps the quote at the rejection-feedback free_text limit', () => {
    const c = toReplyClassification({ sentiment: 'negative', responseType: 'rejection', rejectionReason: 'other', rejectionQuote: 'x'.repeat(600) })
    expect(c.responseType === 'rejection' ? c.rejection.quote?.length : null).toBe(500)
  })

  it('drops the reason fields from any other response type', () => {
    expect(
      toReplyClassification({ sentiment: 'positive', responseType: 'meeting_request', rejectionReason: 'budget', rejectionQuote: 'x' }),
    ).toEqual({ sentiment: 'positive', responseType: 'meeting_request' })
  })
})
