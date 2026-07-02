import { describe, it, expect } from 'vitest'
import { inquiryFooterLine, replyUnsubscribeFooterLine } from './inquiry-footer'

const URL = 'https://app.example/q/abc123'

describe('footer phrasing rotation', () => {
  it('is deterministic per (line, seed) — same seed → same phrasing', () => {
    expect(inquiryFooterLine(URL, 'en', 7)).toBe(inquiryFooterLine(URL, 'en', 7))
    expect(replyUnsubscribeFooterLine('ja', 42)).toBe(replyUnsubscribeFooterLine('ja', 42))
  })

  it('varies the phrasing across seeds (not a byte-identical signature)', () => {
    const en = new Set([0, 1, 2, 3].map((s) => inquiryFooterLine(URL, 'en', s)))
    expect(en.size).toBeGreaterThan(1)
    const ja = new Set([0, 1, 2, 3].map((s) => replyUnsubscribeFooterLine('ja', s)))
    expect(ja.size).toBeGreaterThan(1)
  })

  it('inquiry line keeps the URL and a clear opt-out indicator', () => {
    for (const seed of [0, 1, 2, 3, 99, -5]) {
      const en = inquiryFooterLine(URL, 'en', seed)
      expect(en).toContain(URL)
      expect(en).toMatch(/unsubscribe|opt out/i)

      const ja = inquiryFooterLine(URL, 'ja', seed)
      expect(ja).toContain(URL)
      expect(ja).toMatch(/停止/)
    }
  })

  it('reply-based opt-out is link-free and clearly an opt-out instruction', () => {
    for (const seed of [0, 1, 2, 3, 99, -5]) {
      const en = replyUnsubscribeFooterLine('en', seed)
      expect(en).toMatch(/unsubscribe|opt out/i)
      expect(en).not.toMatch(/https?:\/\//)

      const ja = replyUnsubscribeFooterLine('ja', seed)
      expect(ja).toMatch(/配信停止|返信/)
      expect(ja).not.toMatch(/https?:\/\//)
    }
  })

  it('handles negative / fractional / huge seeds without throwing or empty output', () => {
    for (const seed of [-1, -100, 1.9, Number.MAX_SAFE_INTEGER]) {
      expect(inquiryFooterLine(URL, 'en', seed)).toContain(URL)
      expect(replyUnsubscribeFooterLine('en', seed).length).toBeGreaterThan(0)
    }
  })
})
