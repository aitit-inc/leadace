export type SitemapEntry = { loc: string; lastmod: number | null }

export type ParsedSitemap =
  | { kind: 'index'; locs: string[] }
  | { kind: 'urlset'; entries: SitemapEntry[] }

const EVENT_PATH =
  /\b(news|press|releases?|blog|topics|announcements?|updates?|recruit|careers?|jobs)\b/i

const LOC = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const URL_BLOCK = /<url\b[^>]*>([\s\S]*?)<\/url>/gi
const LASTMOD = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i
const SITEMAP_DECL = /^[^\S\n]*sitemap:[^\S\n]*(\S+)/gim

const httpUrl = (raw: string): URL | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
}

export function parseRobotsSitemaps(robotsTxt: string): string[] {
  const out = [...robotsTxt.matchAll(SITEMAP_DECL)]
    .map((m) => m[1])
    .filter((raw): raw is string => raw !== undefined && httpUrl(raw) !== null)
  return [...new Set(out)]
}

export function parseSitemap(xml: string): ParsedSitemap | null {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const locs = [...xml.matchAll(LOC)]
      .map((m) => m[1])
      .filter((loc): loc is string => loc !== undefined && httpUrl(loc) !== null)
    return { kind: 'index', locs }
  }
  if (!/<urlset[\s>]/i.test(xml)) return null
  const entries = [...xml.matchAll(URL_BLOCK)].flatMap(([, block]) => {
    if (block === undefined) return []
    const loc = LOC.exec(block)?.[1]
    LOC.lastIndex = 0
    if (loc === undefined || httpUrl(loc) === null) return []
    const raw = LASTMOD.exec(block)?.[1]
    const parsed = raw === undefined ? Number.NaN : Date.parse(raw)
    return [{ loc, lastmod: Number.isNaN(parsed) ? null : parsed }]
  })
  return { kind: 'urlset', entries }
}

export function preferEventSitemap(locs: readonly string[]): string | undefined {
  return locs.find((l) => EVENT_PATH.test(l)) ?? locs[0]
}

export function orderByEventPreference(urls: readonly string[]): string[] {
  return [...urls].sort((a, b) => Number(EVENT_PATH.test(b)) - Number(EVENT_PATH.test(a)))
}

// A sitemap is third-party input whose content we attribute to this company, so
// an off-site entry could put another company's events — or an attacker's
// text — into our outreach.
export function isSameSite(loc: string, domain: string): boolean {
  const host = httpUrl(loc)?.hostname.toLowerCase()
  if (host === undefined) return false
  const d = domain.toLowerCase()
  return host === d || host.endsWith(`.${d}`)
}

export function selectSignalUrls(
  entries: readonly SitemapEntry[],
  domain: string,
  max: number,
): string[] {
  const usable = entries.filter((e) => isSameSite(e.loc, domain))
  const dated = usable.filter((e) => e.lastmod !== null)
  const pool = dated.length > 0 ? dated : usable
  return [...pool]
    .sort((a, b) => {
      const event = Number(EVENT_PATH.test(b.loc)) - Number(EVENT_PATH.test(a.loc))
      return event !== 0 ? event : (b.lastmod ?? 0) - (a.lastmod ?? 0)
    })
    .slice(0, max)
    .map((e) => e.loc)
}
