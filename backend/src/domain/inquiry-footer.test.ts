import { describe, it, expect } from 'vitest'
import { inquiryFooterLine, unsubscribeFooterLine, privacyFooterLine } from './inquiry-footer'

const URL = 'https://app.example/q/abc123'

describe('footer phrasing rotation', () => {
  it('is deterministic per (line, seed) — same seed → same phrasing', () => {
    expect(inquiryFooterLine(URL, 'en', 7)).toBe(inquiryFooterLine(URL, 'en', 7))
    expect(unsubscribeFooterLine(URL, 'ja', 42)).toBe(unsubscribeFooterLine(URL, 'ja', 42))
  })

  it('varies the phrasing across seeds (not a byte-identical signature)', () => {
    const en = new Set([0, 1, 2, 3].map((s) => inquiryFooterLine(URL, 'en', s)))
    expect(en.size).toBeGreaterThan(1)
    const ja = new Set([0, 1, 2, 3].map((s) => unsubscribeFooterLine(URL, 'ja', s)))
    expect(ja.size).toBeGreaterThan(1)
  })

  it('every variant keeps the URL and a clear opt-out indicator (compliance)', () => {
    for (const seed of [0, 1, 2, 3, 99, -5]) {
      const en = inquiryFooterLine(URL, 'en', seed)
      expect(en).toContain(URL)
      expect(en).toMatch(/unsubscribe|opt out/i)

      const enUnsub = unsubscribeFooterLine(URL, 'en', seed)
      expect(enUnsub).toMatch(/unsubscribe|opt out|stop receiving/i)

      const ja = inquiryFooterLine(URL, 'ja', seed)
      expect(ja).toContain(URL)
      expect(ja).toMatch(/停止/)
    }
  })

  it('handles negative / fractional / huge seeds without throwing or empty output', () => {
    for (const seed of [-1, -100, 1.9, Number.MAX_SAFE_INTEGER]) {
      expect(privacyFooterLine('https://x.example/p', 'en', seed)).toContain('https://x.example/p')
    }
  })
})
