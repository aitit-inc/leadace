import { describe, it, expect } from 'vitest'
import {
  isSameSite,
  orderByEventPreference,
  parseRobotsSitemaps,
  parseSitemap,
  preferEventSitemap,
  selectSignalUrls,
} from './sitemap'

describe('parseRobotsSitemaps', () => {
  it('reads every declaration case-insensitively and dedupes', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /admin',
      'Sitemap: https://acme.com/sitemap.xml',
      'SITEMAP:  https://acme.com/news-sitemap.xml',
      'Sitemap: https://acme.com/sitemap.xml',
    ].join('\n')
    expect(parseRobotsSitemaps(robots)).toEqual([
      'https://acme.com/sitemap.xml',
      'https://acme.com/news-sitemap.xml',
    ])
  })

  it('drops non-http schemes', () => {
    expect(parseRobotsSitemaps('Sitemap: javascript:alert(1)\nSitemap: file:///etc/passwd')).toEqual([])
  })
})

describe('parseSitemap', () => {
  it('returns index children', () => {
    const xml = `<?xml version="1.0"?><sitemapindex xmlns="x">
      <sitemap><loc>https://acme.com/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://acme.com/sitemap-news.xml</loc></sitemap>
    </sitemapindex>`
    expect(parseSitemap(xml)).toEqual({
      kind: 'index',
      locs: ['https://acme.com/sitemap-pages.xml', 'https://acme.com/sitemap-news.xml'],
    })
  })

  it('parses urlset entries and normalizes lastmod to epoch millis', () => {
    const xml = `<urlset xmlns="x">
      <url><loc>https://acme.com/news/a</loc><lastmod>2026-07-20</lastmod></url>
      <url><loc>https://acme.com/about</loc></url>
      <url><loc>https://acme.com/bad</loc><lastmod>not-a-date</lastmod></url>
    </urlset>`
    expect(parseSitemap(xml)).toEqual({
      kind: 'urlset',
      entries: [
        { loc: 'https://acme.com/news/a', lastmod: Date.parse('2026-07-20') },
        { loc: 'https://acme.com/about', lastmod: null },
        { loc: 'https://acme.com/bad', lastmod: null },
      ],
    })
  })

  it('returns null for a body that is neither', () => {
    expect(parseSitemap('<html><body>404</body></html>')).toBeNull()
  })
})

describe('preferEventSitemap', () => {
  it('picks an event-ish child over the first one', () => {
    expect(
      preferEventSitemap(['https://acme.com/sitemap-pages.xml', 'https://acme.com/sitemap-news.xml']),
    ).toBe('https://acme.com/sitemap-news.xml')
  })

  it('falls back to the first child', () => {
    expect(preferEventSitemap(['https://acme.com/a.xml', 'https://acme.com/b.xml'])).toBe(
      'https://acme.com/a.xml',
    )
  })

  it('handles an empty index', () => {
    expect(preferEventSitemap([])).toBeUndefined()
  })
})

describe('selectSignalUrls', () => {
  const d = (iso: string) => Date.parse(iso)

  it('ranks event paths first, then newest lastmod, and caps', () => {
    const entries = [
      { loc: 'https://acme.com/about', lastmod: d('2026-07-24') },
      { loc: 'https://acme.com/news/old', lastmod: d('2026-01-01') },
      { loc: 'https://acme.com/news/new', lastmod: d('2026-07-20') },
      { loc: 'https://acme.com/pricing', lastmod: d('2026-07-23') },
    ]
    expect(selectSignalUrls(entries, 'acme.com', 3)).toEqual([
      'https://acme.com/news/new',
      'https://acme.com/news/old',
      'https://acme.com/about',
    ])
  })

  it('ignores undated entries while any dated one exists', () => {
    const entries = [
      { loc: 'https://acme.com/undated', lastmod: null },
      { loc: 'https://acme.com/dated', lastmod: d('2026-07-20') },
    ]
    expect(selectSignalUrls(entries, 'acme.com', 3)).toEqual(['https://acme.com/dated'])
  })

  it('falls back to undated entries when none carry lastmod', () => {
    const entries = [
      { loc: 'https://acme.com/about', lastmod: null },
      { loc: 'https://acme.com/news/a', lastmod: null },
    ]
    expect(selectSignalUrls(entries, 'acme.com', 3)).toEqual([
      'https://acme.com/news/a',
      'https://acme.com/about',
    ])
  })

  it('keeps subdomains but drops other sites', () => {
    const entries = [
      { loc: 'https://news.acme.com/a', lastmod: d('2026-07-20') },
      { loc: 'https://evil.example/a', lastmod: d('2026-07-24') },
      { loc: 'https://notacme.com/a', lastmod: d('2026-07-24') },
    ]
    expect(selectSignalUrls(entries, 'acme.com', 3)).toEqual(['https://news.acme.com/a'])
  })

  it('returns nothing when every entry is off-site', () => {
    expect(
      selectSignalUrls([{ loc: 'https://evil.example/a', lastmod: 1 }], 'acme.com', 3),
    ).toEqual([])
  })
})

// Gates which sitemaps we fetch, so a host that merely looks like the domain
// must not pass.
describe('isSameSite', () => {
  it('accepts the domain and its subdomains', () => {
    expect(isSameSite('https://acme.com/sitemap.xml', 'acme.com')).toBe(true)
    expect(isSameSite('https://www.acme.com/sitemap.xml', 'acme.com')).toBe(true)
  })

  it('rejects hosts that only end or start with the domain text', () => {
    expect(isSameSite('https://notacme.com/sitemap.xml', 'acme.com')).toBe(false)
    expect(isSameSite('https://acme.com.evil.test/sitemap.xml', 'acme.com')).toBe(false)
  })

  it('rejects paths and queries carrying the domain', () => {
    expect(isSameSite('https://evil.test/acme.com/sitemap.xml', 'acme.com')).toBe(false)
    expect(isSameSite('https://evil.test/s.xml?host=acme.com', 'acme.com')).toBe(false)
  })

  it('rejects non-http schemes and unparseable input', () => {
    expect(isSameSite('file:///etc/passwd', 'acme.com')).toBe(false)
    expect(isSameSite('not a url', 'acme.com')).toBe(false)
  })
})

describe('orderByEventPreference', () => {
  it('moves event-ish sitemaps ahead of the rest', () => {
    expect(
      orderByEventPreference([
        'https://acme.com/sitemap.xml',
        'https://acme.com/news-sitemap.xml',
      ]),
    ).toEqual(['https://acme.com/news-sitemap.xml', 'https://acme.com/sitemap.xml'])
  })

  it('keeps relative order when none are event-ish', () => {
    expect(orderByEventPreference(['https://acme.com/a.xml', 'https://acme.com/b.xml'])).toEqual([
      'https://acme.com/a.xml',
      'https://acme.com/b.xml',
    ])
  })
})
