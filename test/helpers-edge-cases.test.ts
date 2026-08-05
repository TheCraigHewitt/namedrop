import { describe, expect, it } from 'vitest'
import { parseCsv, parseCsvRows, toCsv } from '../src/lib/csv'
import { registrableDomain } from '../src/lib/domain'
import { addDays, daysBetween, parseFilters, priorPeriod, DEFAULT_WINDOW } from '../src/lib/filters'

/**
 * The pure boundary helpers: URL and CSV parsing, and filter parsing from
 * untrusted query strings. Their edge cases are hard to reach through a page —
 * a malformed citation URL only shows up as a missing Source — so they are
 * asserted directly.
 */

describe('registrableDomain', () => {
  it('drops subdomains and www', () => {
    expect(registrableDomain('https://www.reddit.com/r/podcasting/')).toBe('reddit.com')
    expect(registrableDomain('https://old.reddit.com/r/podcasting/')).toBe('reddit.com')
    expect(registrableDomain('https://blog.transistor.fm/post')).toBe('transistor.fm')
  })

  it('keeps three labels for multi-label public suffixes', () => {
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk')
    expect(registrableDomain('https://shop.example.com.au/x')).toBe('example.com.au')
  })

  it('lowercases and ignores port, path and trailing dot', () => {
    expect(registrableDomain('https://WWW.Castos.COM:8443/features/')).toBe('castos.com')
    expect(registrableDomain('https://castos.com./features')).toBe('castos.com')
  })

  it('returns null rather than a bad Domain for input it cannot parse', () => {
    expect(registrableDomain('not a url')).toBeNull()
    expect(registrableDomain('')).toBeNull()
    expect(registrableDomain('https://')).toBeNull()
  })
})

describe('CSV round trip', () => {
  it('strips a BOM from the first header', () => {
    const rows = parseCsv('﻿domain,type\r\nreddit.com,UGC\r\n')

    expect(rows[0]).toEqual({ domain: 'reddit.com', type: 'UGC' })
  })

  it('reads escaped quotes, embedded commas and embedded newlines', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""","one,two"\r\n"line\nbreak",x\r\n')

    expect(rows[0]).toEqual({ a: 'say "hi"', b: 'one,two' })
    expect(rows[1]!.a).toBe('line\nbreak')
  })

  it('pads a short row rather than dropping the columns', () => {
    expect(parseCsv('a,b,c\r\n1,2\r\n')[0]).toEqual({ a: '1', b: '2', c: '' })
  })

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsvRows('')).toEqual([])
  })

  it('quotes on write exactly what it needs to, and reads back unchanged', () => {
    const csv = toCsv(['a', 'b'], [['say "hi"', 'one,two'], ['plain', '']])

    expect(csv).toContain('"say ""hi""","one,two"')
    expect(csv).toContain('plain,')
    expect(parseCsv(csv)[0]).toEqual({ a: 'say "hi"', b: 'one,two' })
  })
})

describe('parseFilters', () => {
  const url = (query: string) => new URL(`http://dash.test/${query}`)
  const TODAY = '2026-07-28'

  it('defaults to the last 30 days ending today', () => {
    const filters = parseFilters(url(''), TODAY)

    expect(filters).toMatchObject({ from: '2026-06-29', to: TODAY, surface: null, topicId: null, window: DEFAULT_WINDOW })
  })

  it('ignores malformed dates rather than crashing on them', () => {
    // "2026-13-45" matches the shape but is not a date, and "2026-02-30" would
    // silently roll over into March.
    expect(parseFilters(url('?from=last-tuesday&to=2026-13-45'), TODAY)).toMatchObject({ from: '2026-06-29', to: TODAY })
    expect(parseFilters(url('?to=2026-02-30'), TODAY).to).toBe(TODAY)
  })

  it('clamps a range that runs backwards', () => {
    const filters = parseFilters(url('?from=2026-07-28&to=2026-07-01'), TODAY)

    expect(filters.from).toBe('2026-07-01')
    expect(filters.to).toBe('2026-07-01')
  })

  it('rejects a Surface that is not one of ours', () => {
    expect(parseFilters(url('?surface=bard'), TODAY).surface).toBeNull()
    expect(parseFilters(url('?surface=gemini'), TODAY).surface).toBe('gemini')
  })

  it('falls back to the default window for a non-positive or non-integer window', () => {
    expect(parseFilters(url('?window=0'), TODAY).window).toBe(DEFAULT_WINDOW)
    expect(parseFilters(url('?window=-3'), TODAY).window).toBe(DEFAULT_WINDOW)
    expect(parseFilters(url('?window=2.5'), TODAY).window).toBe(DEFAULT_WINDOW)
    expect(parseFilters(url('?window=14'), TODAY).window).toBe(14)
  })

  it('treats an empty Topic as no Topic filter', () => {
    expect(parseFilters(url('?topic='), TODAY).topicId).toBeNull()
  })
})

describe('period arithmetic', () => {
  it('counts an inclusive range and crosses month and year ends', () => {
    expect(daysBetween('2026-07-20', '2026-07-26')).toBe(7)
    expect(daysBetween('2026-07-28', '2026-07-28')).toBe(1)
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('puts the prior period immediately before the selected one, same length', () => {
    const prior = priorPeriod(parseFilters(new URL('http://dash.test/?from=2026-07-20&to=2026-07-26')))

    expect(prior).toEqual({ from: '2026-07-13', to: '2026-07-19' })
  })
})
