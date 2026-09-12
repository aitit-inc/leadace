export const SITE_READ_MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000
const RECENT_SIGNALS = '## Recent Signals'

export function isSiteReadStale(siteReadAt: string | null, now: Date): boolean {
  return siteReadAt === null || now.getTime() - new Date(siteReadAt).getTime() > SITE_READ_MAX_AGE_DAYS * DAY_MS
}

// timingSignals present (even empty) = the site was read for them; omitted = unknown.
export function siteReadPatch(hypothesis: { timingSignals?: string[] } | null | undefined, now: Date): { siteReadAt: Date } | Record<never, never> {
  return hypothesis?.timingSignals !== undefined ? { siteReadAt: now } : {}
}

export function withRecentSignals(overview: string, signals: string[]): string {
  const at = overview.indexOf(RECENT_SIGNALS)
  const plain = (at >= 0 ? overview.slice(0, at) : overview).trimEnd()
  return signals.length > 0 ? `${plain}\n\n${RECENT_SIGNALS}\n${signals.map((s) => `- ${s}`).join('\n')}` : plain
}

export function signalsAfter(overview: string, since: string): string[] {
  const at = overview.indexOf(RECENT_SIGNALS)
  if (at < 0) return []
  return overview
    .slice(at + RECENT_SIGNALS.length)
    .split('\n')
    .flatMap((line) => (line.startsWith('- ') ? [line.slice(2)] : []))
    .filter((s) => s.slice(0, 10) > since.slice(0, 10))
}
