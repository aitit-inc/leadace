import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCfEmail, fetchPage, pageLinks, pageText } from './fetch-page'

// Each case is a page shape seen on real prospect sites, reduced to the part
// that shows it. What a model must be able to read is `contains`; what must not
// reach it is `absent`.
type Case = {
  name: string
  file?: string
  source: string
  status?: number
  contentType?: string
  finalUrl?: string
  fetchError?: true
  usable: boolean
  url?: string
  contains?: string[]
  absent?: string[]
}

const DIR = new URL('./fetch-page.fixtures/', import.meta.url)
const cases = JSON.parse(readFileSync(new URL('cases.json', DIR), 'utf8')) as Case[]
const REQUESTED = 'https://example.jp/'

function respond(c: Case): Response {
  const body = c.file === undefined ? null : readFileSync(new URL(c.file, DIR))
  const res = new Response(body, { status: c.status ?? 200, headers: { 'content-type': c.contentType ?? 'text/html; charset=utf-8' } })
  Object.defineProperty(res, 'url', { value: c.finalUrl ?? REQUESTED })
  return res
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchPage fixtures', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    vi.stubGlobal('fetch', async () => {
      if (c.fetchError) throw new TypeError('fetch failed')
      return respond(c)
    })
    const page = await fetchPage(REQUESTED)
    if (!c.usable) {
      expect(page).toBeNull()
      return
    }
    expect(page).not.toBeNull()
    expect(page?.url).toBe(c.url ?? REQUESTED)
    for (const s of c.contains ?? []) expect(page?.text).toContain(s)
    for (const s of c.absent ?? []) expect(page?.text).not.toContain(s)
  })
})

describe('malformed pages', () => {
  // Quadratic takes seconds at 300 KB; linear, milliseconds.
  it.each([
    ['unclosed blocks and tags', '<script>x '.repeat(30_000) + '<a href="/x">y '.repeat(20_000) + '<span data-cfemail="4242">z '.repeat(10_000)],
    ['a tag that never reaches ">"', '<a href="mailto:' + 'a'.repeat(300_000)],
    ['repeated attributes in an unclosed tag', '<iframe ' + 'src="a" '.repeat(40_000)],
    ['repeated hrefs in an unclosed anchor', '<a ' + 'href="/x" '.repeat(30_000)],
  ])('stay linear: %s', (_, html) => {
    const started = performance.now()
    pageText(html)
    pageLinks(html, REQUESTED)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('ignore a cfemail value that is not an email', () => {
    expect(decodeCfEmail('42'.repeat(200_000))).toBeNull()
    expect(decodeCfEmail('zz11')).toBeNull()
  })
})
