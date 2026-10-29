// Minimal RFC 4180 CSV parser; also accepts LF-only line endings, strips a
// leading UTF-8 BOM and drops blank lines at the end. Caller is responsible for
// header validation, trimming, and row-shape checks.
// Null past maxRows, where it stops reading: 1 MiB of short lines is ~100 MB of rows.
export function parseCsv(text: string, maxRows: number): string[][] | null {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const rows: string[][] = []
  // A count until a row follows, so trailing ones are dropped and never hit maxRows.
  let blankLines = 0
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const endRow = (): boolean => {
    row.push(field)
    field = ''
    if (row.length === 1 && row[0] === '') {
      blankLines++
    } else {
      if (rows.length + blankLines >= maxRows) return false
      for (; blankLines > 0; blankLines--) rows.push([''])
      rows.push(row)
    }
    row = []
    return true
  }
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
      if (!endRow()) return null
      continue
    }
    if (c === '\n') {
      if (!endRow()) return null
      continue
    }
    field += c
  }
  if ((field !== '' || row.length > 0) && !endRow()) return null
  return rows
}
