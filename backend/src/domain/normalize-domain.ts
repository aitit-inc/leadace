// Normalize to the apex form stored in `organizations.domain` so LLM- and
// CSV-supplied domains match the dedup index — without this, a candidate passing
// "https://www.example.com/about" silently misses an existing "example.com" row.
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  const cut = s.search(/[/?#:]/)
  if (cut !== -1) s = s.slice(0, cut)
  s = s.replace(/^www\./, '')
  return s
}
