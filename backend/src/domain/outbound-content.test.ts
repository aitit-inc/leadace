import { describe, it, expect } from 'vitest'
import {
  checkOutboundContent,
  contentSimilarity,
  describeContentViolations,
  findNearDuplicate,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeForSimilarity,
  stripAppendedFooter,
  type OutboundContentInput,
} from './outbound-content'

const BASE: OutboundContentInput = {
  subject: 'A quick note on your docs pipeline',
  body: 'Hi Sam,\nSaw your changelog entry on the new ingest API — the retry semantics are unusual.\nWe help teams like yours cut re-processing cost. Worth a quick reply to compare notes?\nBest,\nLeo',
  targetLanguage: 'en',
  appUrl: 'https://app.example.com',
  apiUrl: 'https://api.example.com',
  inquiryCtaType: 'meeting',
  inquiryCtaUrl: null,
  inquiryLandingEnabled: false,
  physicalAddress: '1-2-3 Somewhere, Tokyo 100-0001, Japan',
}

const check = (patch: Partial<OutboundContentInput> = {}) =>
  checkOutboundContent({ ...BASE, ...patch })

describe('checkOutboundContent', () => {
  it('passes a well-formed body', () => {
    expect(check()).toEqual([])
  })

  describe('placeholders', () => {
    it.each([
      ['Hi {first name}, saw your work.'],
      ['Hi {{firstName}}, saw your work.'],
      ['Hi [First Name], saw your work.'],
    ])('rejects %s', (body) => {
      expect(check({ body })).toContainEqual(
        expect.objectContaining({ kind: 'placeholder', field: 'body' }),
      )
    })

    it.each([
      ['You cut spend [30%] last quarter, per your report.'],
      ['Shipping the rewrite is still on my todo list, so I get it.'],
      ['Pricing for the enterprise tier is TBD on our side too.'],
    ])('leaves ordinary prose alone: %s', (body) => {
      expect(check({ body })).toEqual([])
    })

    it('reports a markdown link as a link problem, never as a placeholder', () => {
      const body = 'Grab a slot here: [my calendar](https://cal.example.org/leo).'
      expect(check({ body })).toEqual([])
      expect(
        check({ body, inquiryCtaUrl: 'https://cal.example.org/leo', inquiryLandingEnabled: true }),
      ).toEqual([
        expect.objectContaining({ kind: 'forbidden_link', reason: 'cta_with_inquiry_landing' }),
      ])
    })

    it('checks the subject too', () => {
      expect(check({ subject: 'A note for {company}' })).toContainEqual(
        expect.objectContaining({ kind: 'placeholder', field: 'subject' }),
      )
    })

  })

  describe('forbidden links', () => {
    it('rejects our own app host, scheme or not', () => {
      expect(check({ body: 'More at app.example.com/x' })).toContainEqual({
        kind: 'forbidden_link',
        needle: 'app.example.com',
        reason: 'own_host',
      })
    })

    it('rejects the signup URL regardless of inquiry landing', () => {
      const input = {
        inquiryCtaType: 'signup' as const,
        inquiryCtaUrl: 'https://signup.example.org/start',
        inquiryLandingEnabled: false,
        body: 'Sign up at https://signup.example.org/start when ready.',
      }
      expect(check(input)).toContainEqual(
        expect.objectContaining({ kind: 'forbidden_link', reason: 'signup_cta' }),
      )
    })

    it('rejects the scheduling URL only while inquiry landing is on', () => {
      const shared = {
        inquiryCtaUrl: 'https://cal.example.org/leo',
        body: 'Grab a slot: https://cal.example.org/leo',
      }
      expect(check({ ...shared, inquiryLandingEnabled: true })).toContainEqual(
        expect.objectContaining({ kind: 'forbidden_link', reason: 'cta_with_inquiry_landing' }),
      )
      expect(check({ ...shared, inquiryLandingEnabled: false })).toEqual([])
    })

    it('skips a bare-host CTA URL — indistinguishable from naming your own domain', () => {
      expect(
        check({
          inquiryCtaType: 'signup',
          inquiryCtaUrl: 'https://acme.example.org',
          body: 'We are the team behind acme.example.org, and your pipeline looks like ours did.',
        }),
      ).toEqual([])
    })
  })

  describe('footer duplication', () => {
    it('rejects the legal address restated in the body', () => {
      const body = `${BASE.body}\nSurpassOne Inc., 1-2-3 Somewhere,  Tokyo 100-0001, Japan`
      expect(check({ body })).toContainEqual({
        kind: 'footer_in_body',
        part: 'physical_address',
      })
    })

    it('rejects a self-written separator line', () => {
      expect(check({ body: `${BASE.body}\n---\nUnsubscribe by replying.` })).toContainEqual({
        kind: 'footer_in_body',
        part: 'separator',
      })
    })
  })

  describe('length ceiling', () => {
    it('allows a body over the guideline target but under the ceiling', () => {
      expect(check({ body: 'word '.repeat(150) })).toEqual([])
    })

    it('rejects an en body past the word ceiling', () => {
      expect(check({ body: 'word '.repeat(221) })).toContainEqual(
        expect.objectContaining({ kind: 'body_too_long', unit: 'words', limit: 220 }),
      )
    })

    it('measures ja in characters, ignoring whitespace', () => {
      const body = 'あ'.repeat(701)
      expect(check({ body, targetLanguage: 'ja' })).toContainEqual(
        expect.objectContaining({ kind: 'body_too_long', unit: 'characters', measured: 701 }),
      )
      expect(check({ body: 'あ'.repeat(700), targetLanguage: 'ja' })).toEqual([])
    })
  })
})

describe('near-duplicate detection', () => {
  const original =
    'Hi Sam, saw the changelog entry on your new ingest API and the retry semantics stood out. We help teams cut re-processing cost. Worth a quick reply to compare notes?'

  it('flags the same message with only the details swapped', () => {
    const clone = original.replace('Sam', 'Alex').replace('ingest', 'export')
    expect(contentSimilarity(original, clone)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD)
  })

  it('does not flag a shared frame whose middle was rewritten', () => {
    const reframed =
      'Hi Sam, your postmortem on the March outage mentions a manual replay step, and teams that keep one end up running it far more often than planned. We help teams cut re-processing cost. Worth a quick reply to compare notes?'
    expect(contentSimilarity(original, reframed)).toBeLessThan(NEAR_DUPLICATE_THRESHOLD)
  })

  it('does not flag two genuinely different messages', () => {
    const other =
      'Hi Alex, your talk on incremental builds convinced me you already ran into the cache-invalidation wall. We shipped a fix for exactly that. Open to comparing notes?'
    expect(contentSimilarity(original, other)).toBeLessThan(NEAR_DUPLICATE_THRESHOLD)
  })

  it('returns the closest prior above the threshold', () => {
    const priors = [
      { id: 1, body: 'Completely unrelated message about something else entirely.' },
      { id: 2, body: original.replace('Sam', 'Alex') },
      { id: 3, body: original },
    ]
    expect(findNearDuplicate(original, priors)).toEqual({
      priorOutreachId: 3,
      similarity: 1,
    })
  })

  it('returns null when nothing is close enough', () => {
    expect(findNearDuplicate(original, [{ id: 1, body: 'Short unrelated note.' }])).toBeNull()
  })

  it('ignores the appended footer when comparing', () => {
    const stored = `${original}\n---\nSurpassOne Inc.\n1-2-3 Somewhere, Tokyo\nReply "unsubscribe" to opt out.`
    expect(stripAppendedFooter(stored)).toBe(original)
    expect(contentSimilarity(original, stored)).toBe(1)
  })

  it('ignores links and whitespace when comparing', () => {
    expect(normalizeForSimilarity('Hi there\n\nhttps://x.example/a  ok')).toBe('hithereok')
  })

  it('treats an empty comparison as not duplicated', () => {
    expect(contentSimilarity('', original)).toBe(0)
  })
})

describe('describeContentViolations', () => {
  it('renders one actionable sentence per violation', () => {
    const text = describeContentViolations([
      { kind: 'placeholder', field: 'body', sample: '{first name}' },
      { kind: 'near_duplicate', priorOutreachId: 42, similarity: 0.94 },
    ])
    expect(text).toContain('{first name}')
    expect(text).toContain('#42')
    expect(text).toContain('94%')
  })
})
