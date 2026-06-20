import { describe, it, expect } from 'vitest'
import { buildRejections } from './dashboard'

type Rej = Parameters<typeof buildRejections>[0]

const emptyWindows = (): Rej['recontactWindows'] => ({
  never: { count: 0, samples: [] },
  '3_months': { count: 0, samples: [] },
  '6_months': { count: 0, samples: [] },
  '12_months': { count: 0, samples: [] },
  unspecified: { count: 0, samples: [] },
})

const summary = (over: Partial<Rej> = {}): Rej => ({
  windowDays: null,
  scope: 'all',
  total: 0,
  primaryReasonDistribution: [],
  featureGapNotes: [],
  recontactWindows: emptyWindows(),
  decisionMakerPointers: [],
  notRelevantNotes: [],
  ...over,
})

const gapNote = (over: Partial<Rej['featureGapNotes'][number]>): Rej['featureGapNotes'][number] => ({
  receivedAt: new Date(0),
  freeText: 'x',
  prospectId: 1,
  prospectName: 'P',
  organizationName: 'Org',
  ...over,
})

const pointerRow = (p: {
  name?: string
  role?: string
  email?: string
  org?: string
}): Rej['decisionMakerPointers'][number] => ({
  receivedAt: new Date(0),
  prospectId: 1,
  prospectName: 'P',
  organizationName: p.org ?? 'Org',
  pointer: { name: p.name, role: p.role, email: p.email },
})

const nrNote = (over: Partial<Rej['notRelevantNotes'][number]>): Rej['notRelevantNotes'][number] => ({
  receivedAt: new Date(0),
  freeText: 'x',
  prospectId: 1,
  prospectName: 'P',
  organizationName: 'Org',
  industry: null,
  ...over,
})

describe('buildRejections', () => {
  it('attaches feature_gap quotes to productSignal, dropping empty/whitespace free text', () => {
    const r = buildRejections(
      summary({
        total: 4,
        primaryReasonDistribution: [{ reason: 'feature_gap', count: 4, percentage: 100 }],
        featureGapNotes: [
          gapNote({ freeText: 'need SSO', organizationName: 'Acme' }),
          gapNote({ freeText: '   ', organizationName: 'Blank' }),
          gapNote({ freeText: null, organizationName: 'Null' }),
          gapNote({ freeText: 'API webhooks', organizationName: 'Beta' }),
        ],
      }),
    )
    expect(r.productSignal).toEqual({
      count: 4,
      quotes: [
        { freeText: 'need SSO', prospectName: 'P', organizationName: 'Acme' },
        { freeText: 'API webhooks', prospectName: 'P', organizationName: 'Beta' },
      ],
    })
  })

  it('productSignal is null when there are no feature_gap rejections', () => {
    const r = buildRejections(
      summary({
        total: 2,
        primaryReasonDistribution: [{ reason: 'budget', count: 2, percentage: 100 }],
      }),
    )
    expect(r.productSignal).toBeNull()
  })

  it('caps each qualitative slice at the display limit', () => {
    const gaps = Array.from({ length: 6 }, (_, i) => gapNote({ freeText: `q${i}` }))
    const r = buildRejections(
      summary({
        total: 6,
        primaryReasonDistribution: [{ reason: 'feature_gap', count: 6, percentage: 100 }],
        featureGapNotes: gaps,
      }),
    )
    expect(r.productSignal?.quotes).toHaveLength(3)
  })

  it('keeps decision-maker referrals with ≥1 field, normalizing blanks to null', () => {
    const r = buildRejections(
      summary({
        decisionMakerPointers: [
          pointerRow({ name: 'Tanaka', role: 'CTO', email: '', org: 'Acme' }),
          pointerRow({ name: '  ', role: '', email: '', org: 'AllBlank' }),
          pointerRow({ role: 'Head of Eng', org: 'RoleOnly' }),
        ],
      }),
    )
    expect(r.decisionMakers).toEqual([
      { prospectName: 'P', organizationName: 'Acme', name: 'Tanaka', role: 'CTO', email: null },
      { prospectName: 'P', organizationName: 'RoleOnly', name: null, role: 'Head of Eng', email: null },
    ])
  })

  it('keeps not_relevant notes with text, preserving industry including null', () => {
    const r = buildRejections(
      summary({
        notRelevantNotes: [
          nrNote({ freeText: 'we are B2C', industry: 'Retail', organizationName: 'Acme' }),
          nrNote({ freeText: '', industry: 'X', organizationName: 'Empty' }),
          nrNote({ freeText: 'wrong size', industry: null, organizationName: 'NoInd' }),
        ],
      }),
    )
    expect(r.notRelevant).toEqual([
      { freeText: 'we are B2C', industry: 'Retail', prospectName: 'P', organizationName: 'Acme' },
      { freeText: 'wrong size', industry: null, prospectName: 'P', organizationName: 'NoInd' },
    ])
  })

  it('emits empty slices and null signals when nothing qualitative is present', () => {
    const r = buildRejections(summary({ total: 0 }))
    expect(r.productSignal).toBeNull()
    expect(r.decisionMakers).toEqual([])
    expect(r.notRelevant).toEqual([])
    expect(r.recontactSoon).toBeNull()
  })
})
