import { describe, it, expect } from 'vitest'
import { keepNewestRetired, newlyRetiredClaims, parseLearnings, retireWithdrawnMetricEntries, stampNewRetirements } from './learnings'

describe('retireWithdrawnMetricEntries', () => {
  it('tombstones an entry citing a withdrawn metric', () => {
    const log = '- [targeting] [2026-09-09] signal 持ちは返信率が高い — evidence: metric=freshSignalResponseRate withSignal 13.1% n=61'
    expect(retireWithdrawnMetricEntries(log)).toBe(
      '- [retired] [2026-09-09] signal 持ちは返信率が高い — evidence: metric=freshSignalResponseRate withSignal 13.1% n=61',
    )
  })

  it('leaves entries citing live metrics alone, including free-form citations', () => {
    const log = [
      '# Learnings Log',
      '',
      '- [body] [2026-09-09] proof-led が牽引 — evidence: metric=variantResponseRate rst_20260715_b 8.8% n=114',
      '- [channel] [2026-08-31] フォームは人の返信ゼロ — evidence: metric=form 人の返信 0件 / form 送信 41件, n=41',
    ].join('\n')
    expect(retireWithdrawnMetricEntries(log)).toBe(log)
  })

  it('keeps an existing tombstone as it is', () => {
    const log = '- [retired] [2026-08-25] 旧説 — evidence: metric=freshSignalResponseRate withSignal 10.8% n=37'
    expect(retireWithdrawnMetricEntries(log)).toBe(log)
  })

  it('tombstones the nested citation form entries use for lever axes', () => {
    const log = '- [targeting] [2026-09-09] signal は効く — evidence: metric=targetingLifts.freshSignalResponseRate 0.5 n=61'
    expect(retireWithdrawnMetricEntries(log)).toMatch(/^- \[retired\]/)
  })

  it('does not match a longer metric name that starts with a withdrawn one', () => {
    const log = '- [targeting] [2026-09-09] 別指標 — evidence: metric=freshSignalResponseRateV2 12% n=61'
    expect(retireWithdrawnMetricEntries(log)).toBe(log)
  })
})

describe('parseLearnings', () => {
  it('parses a well-formed entry and trims the evidence tail', () => {
    const entries = parseLearnings(
      '[targeting] [2026-06-10] SaaS firms under 50 staff reply best — evidence: metric=replyRate, n=42',
    )
    expect(entries).toEqual([
      {
        stage: 'targeting',
        date: '2026-06-10',
        claim: 'SaaS firms under 50 staff reply best',
        evidence: 'metric=replyRate, n=42',
      },
    ])
  })

  it('keeps the claim when no evidence tail is present', () => {
    const entries = parseLearnings('[body] [2026-06-01] short openers outperform long ones')
    expect(entries).toEqual([
      { stage: 'body', date: '2026-06-01', claim: 'short openers outperform long ones', evidence: null },
    ])
  })

  it('drops [retired] tombstones and unrecognized stages', () => {
    const entries = parseLearnings(
      [
        '[retired] [2026-05-01] old claim — evidence: metric=x, n=9',
        '[bogus] [2026-05-02] not a real stage',
        '[channel] [2026-06-02] LinkedIn DMs land warmer when referencing a hire — evidence: metric=replyRate, n=31',
      ].join('\n'),
    )
    expect(entries).toEqual([
      {
        stage: 'channel',
        date: '2026-06-02',
        claim: 'LinkedIn DMs land warmer when referencing a hire',
        evidence: 'metric=replyRate, n=31',
      },
    ])
  })

  it('parses [discovery] entries', () => {
    const entries = parseLearnings(
      '[discovery] [2026-07-01] github-topics sources reply best — evidence: metric=replyRate, n=34',
    )
    expect(entries).toEqual([
      {
        stage: 'discovery',
        date: '2026-07-01',
        claim: 'github-topics sources reply best',
        evidence: 'metric=replyRate, n=34',
      },
    ])
  })

  it('skips headers/blank lines and tolerates a leading markdown bullet', () => {
    const entries = parseLearnings(
      ['# Learnings Log', '', '- [timing] [2026-06-05] 3-month recontacts convert — evidence: metric=meetingRate, n=12'].join(
        '\n',
      ),
    )
    expect(entries).toEqual([
      { stage: 'timing', date: '2026-06-05', claim: '3-month recontacts convert', evidence: 'metric=meetingRate, n=12' },
    ])
  })

  it('returns entries newest-first regardless of document order (so the truncated glance is deterministic)', () => {
    const entries = parseLearnings(
      [
        '[targeting] [2026-05-01] older claim',
        '[body] [2026-06-15] newer claim',
        '[channel] [2026-06-01] middle claim',
      ].join('\n'),
    )
    expect(entries.map((e) => e.date)).toEqual(['2026-06-15', '2026-06-01', '2026-05-01'])
  })

  it('returns an empty list for null or blank content', () => {
    expect(parseLearnings(null)).toEqual([])
    expect(parseLearnings('')).toEqual([])
    expect(parseLearnings('\n\n')).toEqual([])
  })
})

describe('newlyRetiredClaims', () => {
  const before = [
    '# Learnings',
    '- [targeting] [2026-09-01] SaaS under 50 replies twice as often — evidence: metric=x, n=40',
    '- [retired] [2026-08-02] An older mistake — evidence: metric=y, n=10',
  ].join('\n')

  it('returns the claims tombstoned since the earlier version', () => {
    const after = before.replace('[targeting] [2026-09-01]', '[retired] [2026-09-01]')
    expect(newlyRetiredClaims(before, after)).toEqual(['SaaS under 50 replies twice as often'])
  })

  it('ignores tombstones that were already there', () => {
    expect(newlyRetiredClaims(before, before)).toEqual([])
  })

  it('treats every tombstone as new when there is no earlier version', () => {
    expect(newlyRetiredClaims(null, before)).toEqual(['An older mistake'])
  })
})

describe('keepNewestRetired', () => {
  const log = [
    '# Learnings Log',
    '- [body] [2026-09-24] active claim — evidence: metric=a, n=40',
    '- [retired] [2026-08-25] oldest — evidence: metric=b, n=30',
    '- [retired] [discovery] [2026-09-09] newest — evidence: metric=c, n=30',
    '- [retired] [2026-08-31] middle — evidence: metric=d, n=30',
  ].join('\n')

  it('drops the oldest tombstones past the limit and keeps everything else in place', () => {
    expect(keepNewestRetired(log, 2)).toBe(
      [
        '# Learnings Log',
        '- [body] [2026-09-24] active claim — evidence: metric=a, n=40',
        '- [retired] [discovery] [2026-09-09] newest — evidence: metric=c, n=30',
        '- [retired] [2026-08-31] middle — evidence: metric=d, n=30',
      ].join('\n'),
    )
  })

  it('leaves a log within the limit untouched', () => {
    expect(keepNewestRetired(log, 3)).toBe(log)
  })
})

describe('stampNewRetirements', () => {
  const before = [
    '- [body] [2026-08-01] proof-led wins — evidence: metric=a, n=40',
    '- [targeting] [2026-08-02] 1-10 respond more — evidence: metric=b, n=40',
    '- [retired] [2026-07-01] old claim — evidence: metric=c, n=30',
  ].join('\n')

  it('dates a newly retired entry by the day it was retired, and leaves earlier tombstones alone', () => {
    const after = before.replace('- [body] [2026-08-01]', '- [retired] [2026-08-01]')
    expect(stampNewRetirements(before, after, '2026-09-29')).toBe(
      [
        '- [retired] [2026-09-29] proof-led wins — evidence: metric=a, n=40',
        '- [targeting] [2026-08-02] 1-10 respond more — evidence: metric=b, n=40',
        '- [retired] [2026-07-01] old claim — evidence: metric=c, n=30',
      ].join('\n'),
    )
  })

  it('adds the date to a tombstone written without one', () => {
    expect(stampNewRetirements(null, '- [retired] undated claim', '2026-09-29')).toBe('- [retired] [2026-09-29] undated claim')
  })

  it('keeps a just-retired old claim past newer tombstones', () => {
    const tombstones = ['- [retired] [2026-09-10] x', '- [retired] [2026-09-11] y']
    const prior = ['- [body] [2026-08-01] proof-led wins', ...tombstones].join('\n')
    const retired = prior.replace('- [body]', '- [retired]')
    expect(keepNewestRetired(stampNewRetirements(prior, retired, '2026-09-29'), 2)).toBe(
      ['- [retired] [2026-09-29] proof-led wins', '- [retired] [2026-09-11] y'].join('\n'),
    )
  })
})
