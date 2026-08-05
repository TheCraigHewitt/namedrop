/**
 * Sources roll up to their registrable Domain (reddit.com, not
 * old.reddit.com/r/podcasting). A full public-suffix list is far more than this
 * needs, so multi-label suffixes we actually see in podcast-hosting answers are
 * listed explicitly and everything else takes the last two labels.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.nz',
  'co.za',
  'co.jp',
  'co.in',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.mx',
  'com.tr',
  'com.sg',
  'com.hk',
])

/** Returns the registrable domain of a URL, or null if it cannot be parsed. */
export function registrableDomain(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }

  if (host === '') return null
  host = host.replace(/^www\./, '').replace(/\.$/, '')

  const labels = host.split('.')
  if (labels.length <= 2) return host

  const lastTwo = labels.slice(-2).join('.')
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}
