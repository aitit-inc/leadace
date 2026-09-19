import type { z } from 'zod'
import { fetchPage } from '../fetch-page'
import { LlmError, type UrlJsonResult } from './common'
import type { FetchedPage } from '../fetch-page'
import { callOpenAIJson, callOpenAISearchJson, type OpenAICall } from './openai'

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// A Worker holds six connections waiting for headers, shared with the model
// calls in flight; a queued fetch would spend its deadline waiting for a slot.
const FETCH_POOL = 3

async function fetchAll(urls: string[]): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = []
  const queue = [...urls]
  await Promise.all(
    Array.from({ length: Math.min(FETCH_POOL, queue.length) }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        const page = await fetchPage(url)
        if (page) pages.push(page)
      }
    }),
  )
  return pages
}

// The URL asked for names the page only when the redirect stayed on its site;
// a jump elsewhere means its own content was never seen.
function readUrls(p: FetchedPage): string[] {
  return domainOf(p.requestedUrl) === domainOf(p.url) ? [p.requestedUrl, p.url] : [p.url]
}

// Fetched pages go to the model as text. When none can be fetched (a bot wall,
// a page drawn by JavaScript) a web search held to the pages' domains reads
// them instead; it bills per call, so it only runs then.
export async function callOpenAIPagesJson<T>(
  args: OpenAICall & { urls: string[]; prompt: string; schema: z.ZodType<T> },
): Promise<UrlJsonResult<T>> {
  const pages = await fetchAll(args.urls)
  if (pages.length > 0) {
    // A page must not be able to open a block that claims another page's URL.
    const blocks = pages.map((p) => `<<<PAGE ${p.url}>>>\n${p.text.replace(/<<</g, '<< <')}\n<<<END PAGE>>>`).join('\n\n')
    const value = await callOpenAIJson({ ...args, prompt: `${args.prompt}\n\nThe pages as fetched (their text, then the links they carry):\n\n${blocks}` })
    return { value, retrievedUrls: [...new Set(pages.flatMap(readUrls))] }
  }
  const domains = [...new Set(args.urls.map(domainOf).filter((d) => d !== null))]
  if (domains.length === 0) throw new LlmError('no readable URL', 422)
  // Search bills per call, which flex does not halve.
  const { value, searchedUrls } = await callOpenAISearchJson({
    ...args,
    flexTimeoutMs: null,
    domains,
    prompt: `${args.prompt}\n\nThese pages could not be fetched directly: read them, and only pages on their sites, with web search.`,
  })
  return { value, retrievedUrls: searchedUrls }
}
