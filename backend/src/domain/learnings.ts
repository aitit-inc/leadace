// Withdrawn because the measurement itself was unsound, not because the
// numbers moved: no observation can retract such a metric, so the call is
// made here when the metric leaves the evaluate payload.
const WITHDRAWN_METRICS = [
  // #494: had_fresh_signal was set by the ordering that already preferred
  // signal-carrying prospects, so the rate compared a selected arm to its leftovers.
  'freshSignalResponseRate',
] as const

const ENTRY_TAG = /^(\s*-\s*\[)([a-z]+)(\])/
// One regex per metric, so an empty list matches nothing rather than matching
// every "metric=". The optional prefix covers the nested form entries use for
// lever axes (metric=targetingLifts.discoveryStrategy).
const WITHDRAWN_CITATIONS = WITHDRAWN_METRICS.map(
  (m) => new RegExp(`metric=(?:[A-Za-z0-9_]+\\.)?${m}(?![A-Za-z0-9_])`),
)

export function retireWithdrawnMetricEntries(log: string): string {
  return log
    .split('\n')
    .map((line) => {
      const tag = ENTRY_TAG.exec(line)
      if (!tag || tag[2] === 'retired' || !WITHDRAWN_CITATIONS.some((re) => re.test(line))) return line
      return line.replace(ENTRY_TAG, '$1retired$3')
    })
    .join('\n')
}
