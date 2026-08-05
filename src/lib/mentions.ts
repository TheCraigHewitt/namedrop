/**
 * Deterministic Brand detection. No LLM is involved in the metrics path: a
 * Mention is an alias matching the Response text on word boundaries, and
 * Position is the order of first appearance among the Brands mentioned.
 */
import type { Brand, Mention } from './types'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Word-bounded matcher. `\b` is wrong at a non-word edge — "Anchor.fm" ends in
 * "m" but an alias could end in punctuation — so the boundaries are explicit
 * lookarounds on word characters.
 */
const aliasPattern = (alias: string) => new RegExp(`(?<![\\w])${escapeRegExp(alias)}(?![\\w])`, 'gi')

/** The word immediately after `index`, lowercased, or '' at end of text. */
function nextWord(text: string, index: number): string {
  const rest = text.slice(index)
  const match = /^[^\p{L}\p{N}]*([\p{L}\p{N}']+)/u.exec(rest)
  return match ? match[1]!.toLowerCase() : ''
}

/**
 * Detects every tracked Brand in a Response.
 *
 * Overlapping aliases of the same Brand ("Acme" inside "acme.com") share a
 * start offset and count once. An alias carrying `notFollowedBy` is skipped when
 * the following word is on that list, which is how "Anchor" avoids firing on
 * "anchor text" while still matching a bare "Anchor" in a list of hosts.
 */
export function detectMentions(text: string, brands: Brand[]): Mention[] {
  const found: { brandId: string; firstIndex: number; count: number }[] = []

  for (const brand of brands) {
    const offsets = new Set<number>()

    for (const alias of brand.aliases) {
      const pattern = aliasPattern(alias.text)
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        if (alias.notFollowedBy.length > 0) {
          const following = nextWord(text, match.index + match[0].length)
          if (alias.notFollowedBy.includes(following)) continue
        }
        offsets.add(match.index)
      }
    }

    if (offsets.size > 0) {
      found.push({ brandId: brand.id, firstIndex: Math.min(...offsets), count: offsets.size })
    }
  }

  // Position: 1 = the Brand named first in the Response.
  found.sort((a, b) => a.firstIndex - b.firstIndex || a.brandId.localeCompare(b.brandId))
  return found.map((entry, index) => ({ ...entry, position: index + 1 }))
}
