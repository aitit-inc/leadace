// Minimal RFC 4180 CSV parser. Pure CPU; no I/O.
//
// Supports:
//   - quoted fields with embedded commas/newlines
//   - escaped double quotes inside quoted fields ("")
//   - CRLF and LF line endings
//   - leading UTF-8 BOM (stripped)
//
// Returns rows as `string[][]`. Caller is responsible for header validation,
// trimming, and row-shape checks.
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue }
        inQuotes = false
        continue
      }
      field += c
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
      continue
    }
    if (c === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
      continue
    }
    field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
