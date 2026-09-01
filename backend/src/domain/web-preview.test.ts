import { describe, expect, it } from 'vitest'
import { webPreviewLlmOutputSchema } from './web-preview'

const segment = (name: string) => ({ name, who: 'Ops leads at 20-80 person shops', why: 'They lose hours to it' })
const email = (segment: string, body = 'Hi,\n\nSaw the team is hiring for ops. Worth a quick reply to compare notes?') => ({
  segment,
  to: `Head of Operations at a ${segment} company`,
  subject: 'A shorter week for your ops team',
  body,
})
const valid = {
  company: { name: 'Acme', oneLiner: 'Scheduling for field teams.' },
  locale: 'en',
  legalName: null,
  postalAddress: null,
  segments: [segment('Logistics'), segment('Field service'), segment('Construction')],
  emails: [email('Logistics'), email('Field service'), email('Construction')],
}

describe('webPreviewLlmOutputSchema', () => {
  it('accepts a well-formed answer', () => {
    expect(webPreviewLlmOutputSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects duplicate segment names, case-insensitively', () => {
    const dup = { ...valid, segments: [segment('Logistics'), segment('logistics '), segment('Construction')] }
    expect(webPreviewLlmOutputSchema.safeParse(dup).success).toBe(false)
  })

  it('rejects links in any spelling, placeholders, and a footer separator in the body', () => {
    for (const body of [
      'See www.acme.com for details.',
      'Book at acme.io/demo',
      'Hi {first_name},',
      'Thanks\n---\nAcme Inc.',
    ]) {
      const bad = { ...valid, emails: [email('Logistics', body), email('Field service'), email('Construction')] }
      expect(webPreviewLlmOutputSchema.safeParse(bad).success, body).toBe(false)
    }
  })

  it('rejects anything but exactly three segments', () => {
    const four = { ...valid, segments: [...valid.segments, segment('Retail')] }
    expect(webPreviewLlmOutputSchema.safeParse(four).success).toBe(false)
  })
})
