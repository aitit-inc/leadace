import { describe, expect, it } from 'vitest'
import { pickChannel, summarizeDraftOutcomes } from './draft'
import type { ReachableProspect } from '../prospects'

const base = {
  ppId: 1,
  prospectId: 1,
  name: 'Acme',
  contactName: null,
  overview: '',
  industry: 'B2B SaaS',
  websiteUrl: 'https://acme.example',
  email: null,
  contactFormUrl: null,
  formType: null,
  snsAccounts: null,
  platformUrl: null,
  discoveryStrategy: null,
  notes: null,
  matchReason: '',
  priority: 3,
  status: 'new',
  organizationId: 1,
  country: 'US',
  hasFreshSignal: false,
  hypothesis: { bestChannel: null, bestKeyperson: null },
  channelAffinity: [],
  cycle: { n: 0, kind: 'first', touchNumber: 1, lastOutreach: null, lastResponse: null },
} satisfies ReachableProspect

const ALL = ['email', 'form', 'sns_twitter', 'sns_linkedin'] as const

describe('pickChannel', () => {
  it('picks email whenever an address exists', () => {
    expect(pickChannel({ ...base, email: 'a@acme.example', contactFormUrl: 'https://acme.example/contact' }, ALL, 'send')).toBe('email')
  })
  it('never picks a browser channel in send mode — the hosted agent has no hands', () => {
    expect(pickChannel({ ...base, contactFormUrl: 'https://acme.example/contact' }, ALL, 'send')).toBeNull()
    expect(pickChannel({ ...base, snsAccounts: { linkedin: 'https://linkedin.com/in/x' } }, ALL, 'send')).toBeNull()
  })
  it('drafts form / SNS in draft mode, LinkedIn before form before X', () => {
    expect(pickChannel({ ...base, contactFormUrl: 'https://acme.example/contact', snsAccounts: { x: '@acme', linkedin: 'https://linkedin.com/in/x' } }, ALL, 'draft')).toBe('sns_linkedin')
    expect(pickChannel({ ...base, contactFormUrl: 'https://acme.example/contact', snsAccounts: { x: '@acme' } }, ALL, 'draft')).toBe('form')
  })
  it('respects the enabled channels and the measured affinity order', () => {
    expect(pickChannel({ ...base, email: 'a@acme.example', contactFormUrl: 'https://acme.example/contact' }, ['form'], 'draft')).toBe('form')
    expect(
      pickChannel(
        {
          ...base,
          email: 'a@acme.example',
          contactFormUrl: 'https://acme.example/contact',
          channelAffinity: [{ channel: 'form', rate: 5, total: 40, responses: 2 }, { channel: 'email', rate: 1, total: 100, responses: 1 }],
        },
        ALL,
        'draft',
      ),
    ).toBe('form')
  })
})

describe('summarizeDraftOutcomes', () => {
  it('counts each outcome once and lists variant ids without duplicates', () => {
    const r = summarizeDraftOutcomes(
      [
        { kind: 'sent', outreachId: 1, channel: 'email', variantId: 'a' },
        { kind: 'drafted', outreachId: 2, channel: 'form', variantId: 'a' },
        { kind: 'skipped', reason: 'bad_timing: layoffs' },
        { kind: 'failed', error: 'x' },
        { kind: 'needs_hands' },
      ],
      2,
    )
    expect(r).toMatchObject({ sent: 1, drafted: 1, skipped: 1, failed: 1, needsHands: 3, variantIds: ['a'] })
  })
})
