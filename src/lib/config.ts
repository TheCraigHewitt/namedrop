/**
 * Config-as-code: the tracked Prompts, Topics, Brands and the Domain Type seed
 * map are versioned JSON in config/, bundled into the Worker at build time.
 * Editing tracking is a git commit; `syncConfig` reconciles D1 with these files.
 */
import brandsJson from '../../config/brands.json'
import domainTypesJson from '../../config/domain-types.json'
import promptsJson from '../../config/prompts.json'
import topicsJson from '../../config/topics.json'
import type { Alias, Brand, DomainType, Prompt, Topic } from './types'

type RawAlias = string | { text: string; notFollowedBy?: string[] }

const normalizeAlias = (raw: RawAlias): Alias =>
  typeof raw === 'string'
    ? { text: raw.toLowerCase(), notFollowedBy: [] }
    : { text: raw.text.toLowerCase(), notFollowedBy: (raw.notFollowedBy ?? []).map((w) => w.toLowerCase()) }

export const TOPICS: Topic[] = topicsJson

export const PROMPTS: Prompt[] = promptsJson

export const BRANDS: Brand[] = (brandsJson as { id: string; name: string; isSelf?: boolean; domains: string[]; aliases: RawAlias[] }[]).map(
  (brand) => ({
    id: brand.id,
    name: brand.name,
    isSelf: brand.isSelf ?? false,
    domains: brand.domains,
    aliases: dedupeAliases(brand.aliases.map(normalizeAlias)),
  }),
)

/** Alias matching is case-insensitive, so two aliases differing only in case are one alias. */
function dedupeAliases(aliases: Alias[]): Alias[] {
  const byText = new Map<string, Alias>()
  for (const alias of aliases) {
    const existing = byText.get(alias.text)
    byText.set(
      alias.text,
      existing ? { text: alias.text, notFollowedBy: [...new Set([...existing.notFollowedBy, ...alias.notFollowedBy])] } : alias,
    )
  }
  return [...byText.values()]
}

/** Domain Type seed map from the Peec gap export. Our own domain is absent by design. */
export const DOMAIN_TYPE_SEEDS: Record<string, DomainType> = domainTypesJson as Record<string, DomainType>

export const SELF_BRAND: Brand = (() => {
  const self = BRANDS.find((brand) => brand.isSelf)
  if (!self) throw new Error('config/brands.json must mark exactly one Brand as isSelf')
  return self
})()
