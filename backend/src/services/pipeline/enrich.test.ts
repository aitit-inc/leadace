import { describe, expect, it } from 'vitest'
import { contactDecision, datedEvents, inRetrieved, newestFirst, ownPublishedEmails, parseStored, verdictOf } from './enrich'

describe('inRetrieved', () => {
  const retrieved = ['https://Example.com/News/A/']
  it('matches the retrieved page whatever the host case or a trailing slash', () => {
    expect(inRetrieved('https://example.com/News/A', retrieved)).toBe(true)
  })
  it('keeps path case — a page differing only in case is another page', () => {
    expect(inRetrieved('https://example.com/news/a', retrieved)).toBe(false)
  })
  it('rejects a page that was not retrieved', () => {
    expect(inRetrieved('https://example.com/News/B', retrieved)).toBe(false)
  })
})

describe('datedEvents', () => {
  const now = new Date('2026-09-12T00:00:00Z')
  const page = 'https://www.example.com/news/2026'
  const retrieved = [page]
  it('keeps a dated event read from a retrieved page, tagged with its source apex', () => {
    expect(datedEvents([{ text: '2026-08-30: Example opened a Berlin office.', foundOnUrl: 'https://www.example.com/news/2026' }], retrieved, now))
      .toEqual(['2026-08-30: Example opened a Berlin office. (example.com)'])
  })
  it('drops an event whose page was not retrieved', () => {
    expect(datedEvents([{ text: '2026-08-30: Example opened a Berlin office.', foundOnUrl: 'https://www.example.com/about' }], retrieved, now)).toEqual([])
  })
  it('drops an event outside the signal window or without a leading date', () => {
    expect(datedEvents([
      { text: '2026-05-01: Example raised a seed round.', foundOnUrl: page },
      { text: 'Example raised a seed round.', foundOnUrl: page },
      { text: '2026-10-01: Example will exhibit at a trade fair.', foundOnUrl: page },
    ], retrieved, now)).toEqual([])
  })
})

describe('newestFirst', () => {
  it('orders by the leading date, newest first, and drops exact duplicates', () => {
    expect(newestFirst(['2026-07-24: b', '2026-09-01: a', '2026-08-27: c', '2026-09-01: a'])).toEqual(['2026-09-01: a', '2026-08-27: c', '2026-07-24: b'])
  })
})

describe('parseStored', () => {
  const candidate = {
    name: 'Acme', organizationName: 'Acme Inc', websiteUrl: 'https://acme.example',
    overview: 'Builds things', industry: 'Other', matchReason: 'Ships an MCP server',
    priority: 1 as const, signals: [],
  }

  it('applies a default for a field the stored shape predates', () => {
    const { candidates, stale } = parseStored([candidate as never])
    expect(stale).toEqual([])
    expect(candidates[0]?.matchSourceUrls).toEqual([])
  })

  it('drops a shape too old to parse without failing the batch', () => {
    const legacy = { ...candidate, name: 'Old', signals: ['2026-03-12: Series B (TechCrunch)'] }
    const { candidates, stale } = parseStored([legacy as never, candidate as never])
    expect(stale).toEqual(['Old'])
    expect(candidates).toHaveLength(1)
  })
})

describe('contactDecision', () => {
  const none = { email: null, form: null, x: false, linkedin: false }
  it('registers a candidate reachable on a channel the project uses', () => {
    expect(contactDecision({ ...none, email: 'usable' }, ['email'])).toBe('reachable')
    expect(contactDecision({ ...none, form: 'usable' }, ['email', 'form'])).toBe('reachable')
  })
  it('skips a candidate reachable only on channels the project turned off', () => {
    expect(contactDecision({ ...none, form: 'usable', x: true }, ['email'])).toBe('channel_not_enabled')
  })
  it('keeps a refusal even when nothing is reachable', () => {
    expect(contactDecision({ ...none, email: 'refused', form: 'usable' }, ['email'])).toBe('refusal')
  })
  it('finds nothing when the site shows no channel', () => {
    expect(contactDecision(none, ['email', 'form'])).toBe('none')
  })
})

describe('verdictOf', () => {
  it('bills only a send target', () => {
    expect(verdictOf(null, true)).toBe('billable')
    expect(verdictOf('channel_not_enabled', true)).toBe('unreachable')
  })
  it('keeps every candidate the check did not pass out of the targets', () => {
    expect(verdictOf('prereq_unverified', false)).toBe('unqualified')
    expect(verdictOf('no_contact_found', false)).toBe('unqualified')
    expect(verdictOf('site_unreadable', false)).toBe('unqualified')
  })
  it('registers nothing the model did not judge', () => {
    expect(verdictOf('read_failed', false)).toBeNull()
  })
})

describe('ownPublishedEmails', () => {
  const site = 'https://www.example.co.jp/'
  const page = (url: string, text: string) => ({ requestedUrl: url, url, text })
  const email = (address: string, foundOnUrl: string, selfPublished = false) => ({ address, foundOnUrl, noSolicitation: false, salesContact: true, selfPublished })
  const kept = (emails: ReturnType<typeof email>[], pages: ReturnType<typeof page>[], siteUrl = site) => ownPublishedEmails(emails, pages, siteUrl).map((e) => e.address)

  it('keeps an address that is text on a fetched page of the organization\'s own site, whatever its domain', () => {
    const pages = [page('https://www.example.co.jp/news/12', 'お問い合わせはInfo@Example.co.jpまで'), page('https://www.example.co.jp/faq', '連絡先 example.school@gmail.com')]
    expect(kept([email('info@example.co.jp', 'https://www.example.co.jp/news/12'), email('example.school@gmail.com', 'https://www.example.co.jp/faq')], pages))
      .toEqual(['info@example.co.jp', 'example.school@gmail.com'])
  })
  it('reads an address the page broke up against scrapers', () => {
    const pages = [page('https://www.example.co.jp/contact', 'sales ＠ example.co.jp / info [at] example.co.jp / jimu（アット）example.co.jp')]
    expect(kept(['sales@example.co.jp', 'info@example.co.jp', 'jimu@example.co.jp'].map((a) => email(a, 'https://www.example.co.jp/contact')), pages)).toHaveLength(3)
  })
  it('drops an address the page does not carry, or whose page was never fetched', () => {
    const pages = [page('https://www.example.co.jp/company', '代表取締役 山田太郎')]
    expect(kept([email('yamada@example.co.jp', 'https://www.example.co.jp/company'), email('info@example.co.jp', 'https://www.example.co.jp/contact')], pages)).toEqual([])
  })
  it('needs the whole address, not the tail of another or the head of a longer domain', () => {
    const contact = 'https://www.example.co.jp/contact'
    const pages = [page(contact, "media@example.co.jp / o'connor@example.co.jp / info@example.co.jp.evil.test")]
    expect(kept([email('a@example.co.jp', contact), email('connor@example.co.jp', contact), email('info@example.co.jp', contact)], pages)).toEqual([])
    expect(kept([email('media@example.co.jp', contact)], pages)).toEqual(['media@example.co.jp'])
  })
  it('does not read an address out of the link list appended to the page text', () => {
    const pages = [page('https://www.example.co.jp/a', 'Contact us.\n\nLinks on this page:\nhttps://www.example.co.jp/info@example.co.jp/contact')]
    expect(kept([email('info@example.co.jp', 'https://www.example.co.jp/a')], pages)).toEqual([])
  })
  it('counts a host under the site as the site, and no other host', () => {
    const pages = [page('https://en.example.co.jp/contact', 'global@example.co.jp'), page('https://example.co.jp.evil.test/contact', 'info@example.co.jp')]
    expect(kept([email('global@example.co.jp', 'https://en.example.co.jp/contact'), email('info@example.co.jp', 'https://example.co.jp.evil.test/contact')], pages))
      .toEqual(['global@example.co.jp'])
  })
  it('elsewhere, keeps an address only where the organization is judged to have published it itself', () => {
    const release = 'https://prtimes.jp/main/html/rd/p/000000006.000057137.html'
    const roster = 'https://directory.example.org/members/42'
    const pages = [page(release, '本件に関するお問い合わせ info@example.co.jp'), page(roster, 'info@example.co.jp')]
    expect(kept([email('info@example.co.jp', release, true), email('info@example.co.jp', roster, false)], pages).length).toBe(1)
    expect(kept([email('sales@example.co.jp', release, true)], pages)).toEqual([])
  })
  it('hands back the address without the judgment it was kept on', () => {
    const contact = 'https://www.example.co.jp/contact'
    expect(ownPublishedEmails([email('info@example.co.jp', contact)], [page(contact, 'info@example.co.jp')], site))
      .toEqual([{ address: 'info@example.co.jp', foundOnUrl: contact, noSolicitation: false, salesContact: true }])
  })
  it('on a host shared with others, keeps to the path we hold for the organization', () => {
    const shared = 'https://sites.google.com/view/target'
    const pages = [page('https://sites.google.com/view/target/contact', 'target.juku@gmail.com'), page('https://sites.google.com/view/other/contact', 'other.juku@gmail.com')]
    expect(kept([email('target.juku@gmail.com', 'https://sites.google.com/view/target/contact'), email('other.juku@gmail.com', 'https://sites.google.com/view/other/contact')], pages, shared))
      .toEqual(['target.juku@gmail.com'])
  })
  it('outside that path, keeps only an address at the host\'s own domain', () => {
    const section = 'https://majisemi.example/service/'
    const pages = [page('https://majisemi.example/company', 'info@majisemi.example / partner@gmail.com')]
    expect(kept([email('info@majisemi.example', 'https://majisemi.example/company'), email('partner@gmail.com', 'https://majisemi.example/company')], pages, section))
      .toEqual(['info@majisemi.example'])
  })
  it('names the page by the URL asked for or the one it redirected to', () => {
    const pages = [{ requestedUrl: 'https://example.co.jp/inquiry', url: 'https://www.example.co.jp/contact/', text: 'info@example.co.jp' }]
    expect(kept([email('info@example.co.jp', 'https://example.co.jp/inquiry')], pages)).toHaveLength(1)
  })
})
