import { z } from 'zod'
import type { OrgSignals } from '../db/schema'

// Lenient by design: LLM output is best-effort upstream data, not client
// input — bad fields / array entries drop, the rest survives.

// Relative dates ("last month") go stale undetectably once stored.
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/
const ISO_DATE_ANYWHERE = /\d{4}-\d{2}-\d{2}/g

export const HIGHLIGHT_MAX_LENGTH = 200
export const HIGHLIGHTS_MAX_COUNT = 5

// Enforced here because the prompt does not hold it: 12 of 56 highlights came
// back outside the window it asked for.
export const HIGHLIGHT_MAX_AGE_DAYS = 60
const DAY_MS = 86_400_000

// Covers [1], [1, 2], and the dotted [1.5.2] form observed from grounded Gemini.
const CITATION_MARKER = /\[\d+(?:\s*[.,]\s*\d+)*\]/g

// Postgres jsonb rejects \u0000 (and unpaired surrogates) -- strip C0/DEL
// controls and make every payload string well-formed (toWellFormed) so a
// hostile page can't produce a payload the DB refuses.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

const sanitizedString = z
  .string()
  .transform((v) => v.toWellFormed().replace(CONTROL_CHARS, ' ').trim())

// Empty strings / arrays drop to undefined so a content-less sub-object
// never counts as non-empty.
const requiredString = sanitizedString.pipe(z.string().min(1))
const optionalString = requiredString.optional().catch(undefined)
const optionalIsoDate = sanitizedString.pipe(z.string().regex(ISO_DATE_PREFIX)).optional().catch(undefined)
const optionalStringArray = z
  .array(z.unknown())
  .transform((arr) =>
    arr.flatMap((v) => {
      const r = requiredString.safeParse(v)
      return r.success ? [r.data] : []
    }),
  )
  .pipe(z.array(z.string()).min(1))
  .optional()
  .catch(undefined)

const pressReleaseSchema = z.object({
  title: requiredString,
  url: optionalString,
  publishedAt: optionalIsoDate,
})

const fundingSchema = z.object({
  round: optionalString,
  amount: optionalString,
  investors: optionalStringArray,
  announcedAt: optionalIsoDate,
})

const hiringSchema = z.object({
  totalOpen: z.number().int().positive().optional().catch(undefined),
  departments: optionalStringArray,
  sampleTitles: optionalStringArray,
  sourceUrl: optionalString,
})

const leadershipSchema = z.object({
  name: requiredString,
  role: optionalString,
  sourceUrl: optionalString,
})

function hasAnyValue(obj: Record<string, unknown>): boolean {
  return Object.values(obj).some((v) => v !== undefined)
}

function parseEntries<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => schema.safeParse(entry))
    .filter((r) => r.success)
    .map((r) => r.data)
}

function isWithinWindow(iso: string, now: Date): boolean {
  const at = Date.parse(iso.slice(0, 10))
  if (Number.isNaN(at)) return false
  const age = now.getTime() - at
  return age >= 0 && age <= HIGHLIGHT_MAX_AGE_DAYS * DAY_MS
}

// Any date in the sentence may be the event's — "Founded in 2010, Acme raised a
// Series B on 2026-07-20" leads with a date that is not the one being reported.
function isCitableHighlight(text: string, now: Date): boolean {
  return [...text.matchAll(ISO_DATE_ANYWHERE)].some(([iso]) => isWithinWindow(iso, now))
}

function sanitizeHighlights(raw: unknown, now: Date): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toWellFormed().replace(CITATION_MARKER, '').replace(CONTROL_CHARS, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((v) => v.length > 0)
    // Code-point slice: a UTF-16 unit slice could split a surrogate pair,
    // producing a lone surrogate that jsonb rejects at write time. Truncating
    // before the date check keeps the stored text and the check in agreement —
    // a date past the cap would otherwise survive the check and then be cut.
    .map((v) => [...v].slice(0, HIGHLIGHT_MAX_LENGTH).join(''))
    .filter((v) => isCitableHighlight(v, now))
    .slice(0, HIGHLIGHTS_MAX_COUNT)
}

// null = not a JSON object; an object whose every field dropped is {} —
// callers distinguish the two via isEmptySignals.
export function parseOrgSignals(raw: unknown, now: Date): OrgSignals | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const out: OrgSignals = {}

  // These two are events, and either one alone makes the payload non-empty —
  // which is what marks the org as carrying a fresh signal. An undated one is
  // therefore as unusable as an out-of-window one. hiring and leadership below
  // describe current state, not an event, so they carry no date to check.
  const pressReleases = parseEntries(obj.pressReleases, pressReleaseSchema).filter(
    (p) => p.publishedAt !== undefined && isWithinWindow(p.publishedAt, now),
  )
  if (pressReleases.length > 0) out.pressReleases = pressReleases

  const funding = fundingSchema.safeParse(obj.funding)
  if (
    funding.success &&
    hasAnyValue(funding.data) &&
    funding.data.announcedAt !== undefined &&
    isWithinWindow(funding.data.announcedAt, now)
  ) {
    out.funding = funding.data
  }

  const hiring = hiringSchema.safeParse(obj.hiring)
  if (hiring.success && hasAnyValue(hiring.data)) out.hiring = hiring.data

  const leadership = parseEntries(obj.leadership, leadershipSchema)
  if (leadership.length > 0) out.leadership = leadership

  const highlights = sanitizeHighlights(obj.highlights, now)
  if (highlights.length > 0) out.highlights = highlights

  return out
}

export function parseOrgSignalsText(text: string, now: Date): OrgSignals | null {
  try {
    return parseOrgSignals(JSON.parse(text), now)
  } catch {
    return null
  }
}

export function isEmptySignals(s: OrgSignals): boolean {
  return (
    !s.pressReleases?.length &&
    !s.funding &&
    !s.hiring &&
    !s.leadership?.length &&
    !s.highlights?.length
  )
}
