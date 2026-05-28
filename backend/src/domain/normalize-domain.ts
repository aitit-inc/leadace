// Normalize an organization domain to the apex form stored in
// `organizations.domain` (see db/schema.ts). Tolerates raw URLs / scheme /
// path / port / leading "www." so LLM- and CSV-supplied domains land in the
// same shape the dedup index queries against. Without this, a candidate
// passing "https://www.example.com/about" silently misses an existing
// "example.com" row.
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  const cut = s.search(/[/?#:]/)
  if (cut !== -1) s = s.slice(0, cut)
  s = s.replace(/^www\./, '')
  return s
}
