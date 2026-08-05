/** Minimal RFC 4180 CSV reader/writer shared by the config generator and the export endpoints. */

/** Splits CSV text into rows of raw cells, honouring quotes, escaped quotes and embedded newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  // Strip a UTF-8 BOM; Peec's exports carry one and it would poison the first header.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  for (; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** Parses CSV text into objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsvRows(text)
  if (!header) return []
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])))
}

function escapeCell(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/** Renders rows as CSV text with CRLF line endings, as the Peec exports use. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n'
}

/** Renders rows as CSV with every cell quoted — the shape of Peec's matrix-style exports. */
export function toQuotedCsv(rows: (string | number | null | undefined)[][]): string {
  const quote = (value: string | number | null | undefined) =>
    `"${(value === null || value === undefined ? '' : String(value)).replace(/"/g, '""')}"`
  return rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n'
}
