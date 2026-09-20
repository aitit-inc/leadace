import { describe, it, expect } from 'vitest'
import { retireWithdrawnMetricEntries } from './learnings'

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
