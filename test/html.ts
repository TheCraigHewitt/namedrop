/** Small readers for asserting on rendered pages without pulling in a DOM library. */

/** The inner HTML of the first element carrying `attribute="value"`. */
export function block(html: string, attribute: string, value: string, tag = 'tr'): string {
  const pattern = new RegExp(`<${tag}[^>]*\\b${attribute}="${value}"[^>]*>([\\s\\S]*?)</${tag}>`)
  const match = pattern.exec(html)
  if (!match) throw new Error(`No <${tag} ${attribute}="${value}"> in the rendered page`)
  return match[1]!
}

/**
 * Every `data-<name>` table cell in a fragment, as its visible text keyed by the
 * attribute value. Nested markup is stripped, so a cell of Brand tags reads as
 * the Brand names.
 */
export function cells(fragment: string, name = 'metric'): Record<string, string> {
  const pattern = new RegExp(`data-${name}="([^"]+)"[^>]*>([\\s\\S]*?)</td>`, 'g')
  const found: Record<string, string> = {}
  for (const match of fragment.matchAll(pattern)) {
    found[match[1]!] = match[2]!
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return found
}

/** Reads a metric row for one entity, e.g. the leaderboard row for a Brand. */
export const rowFor = (html: string, attribute: string, value: string): Record<string, string> =>
  cells(block(html, attribute, value))

/** Ordered values of an attribute across the whole page, e.g. leaderboard ordering. */
export function attributeOrder(html: string, attribute: string): string[] {
  return [...html.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]!)
}
