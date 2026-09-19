import 'server-only'

/**
 * Pure HTML extraction for one comparent.com profile page — the subset of
 * scripts/prospecting/comparent-crawl.mjs's `extractProfile()` that maps
 * onto real prospect_accounts columns (company, domain, website, city,
 * state, phone, portfolio_size/_method). comparent profiles carry no email,
 * contact name or LinkedIn, so those are deliberately not extracted here —
 * there is nothing to put in them.
 *
 * This is a DELIBERATE, PARALLEL port, not a shared import: the CLI script
 * is a zero-dependency standalone .mjs (Node built-ins only, no TypeScript
 * build) meant to run for hours against thousands of cached pages on an
 * operator's machine; this module is the server-triggered, bounded-batch
 * path (lib/inngest/functions/prospecting-crawl.ts) and needs real types.
 * Forking the regex/anchor logic is the risk this file's comments exist to
 * manage — every "why" below is copied from the .mjs verbatim, because a
 * paraphrase is exactly how a fix silently fails to travel between the two.
 * If you fix an extraction bug here, fix it there too, and vice versa.
 *
 * Pure functions only: no fetch, no fs, no Supabase. Fully unit-testable
 * against saved HTML fixtures.
 */

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&apos;': "'", '&quot;': '"', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
}

const decode = (s: string): string =>
  s.replace(/&#(\d+);|&[a-z]+;/gi, (m, dec: string | undefined) =>
    (dec === undefined ? (NAMED_ENTITIES[m.toLowerCase()] ?? m) : String.fromCodePoint(Number(dec))))

const RAW_TEXT_TAGS = ['script', 'style']

interface RawTextOpen { tag: string; at: number }

/** The earliest `<script`/`<style` at or after `from`, or null. */
function nextRawTextOpen(low: string, from: number): RawTextOpen | null {
  let best: RawTextOpen | null = null
  for (const tag of RAW_TEXT_TAGS) {
    const at = low.indexOf(`<${tag}`, from)
    if (at >= 0 && (best === null || at < best.at)) best = { tag, at }
  }
  return best
}

/** Drops <script>/<style> bodies by index scan — no backtracking, linear. */
function dropRawTextElements(html: string): string {
  const low = html.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const open = nextRawTextOpen(low, i)
    if (!open) return out + html.slice(i)
    out += `${html.slice(i, open.at)} `
    const close = low.indexOf(`</${open.tag}`, open.at)
    const after = close < 0 ? -1 : low.indexOf('>', close)
    if (after < 0) return out
    i = after + 1
  }
}

const stripTags = (html: string): string =>
  decode(dropRawTextElements(html).replace(/<[^<>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => decode(m[1]!))
}

const safeUrl = (h: string): URL | null => { try { return new URL(h) } catch { return null } }

const num = (s: unknown): number | null => {
  if (s == null) return null
  const n = Number(String(s).replace(/[,$%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------- structural page readers
//
// Anchored on markup verified against real saved comparent.com pages (see the
// .mjs's own probe stage), not on guessed prose. Server-rendered Blade/
// Tailwind — no hydration payload — four application/ld+json blocks, a
// header stat strip, and id'd <section> blocks of data-point pairs.

const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

interface JsonLd { parsed: unknown[]; src: string }

/**
 * Every application/ld+json block, parsed where possible plus the raw source.
 *
 * The raw source is not a convenience: comparent emits prose into JSON-LD
 * WITHOUT escaping the quotes in it (an answer reading: we affectionately
 * call "The Family Room"), so JSON.parse throws on exactly the richest
 * profiles. `localBusiness` below falls back to a loose regex over `src` for
 * exactly that reason.
 */
function jsonLd(html: string): JsonLd {
  const parsed: unknown[] = []
  let src = ''
  for (const m of html.matchAll(LD_RE)) {
    const raw = m[1]!.trim()
    src += `${raw}\n`
    try { parsed.push(JSON.parse(raw)) } catch { /* unescaped quotes — the loose reader below covers it */ }
  }
  return { parsed, src }
}

interface LocalBusinessAddress {
  streetAddress: string | null
  addressLocality: string | null
  addressRegion: string | null
  postalCode: string | null
}

interface LocalBusiness {
  name: string
  telephone: string | null
  address: LocalBusinessAddress
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** `obj[key]` narrowed to string, or null — the one-liner this file repeats most. */
function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

function addressFromRecord(obj: Record<string, unknown>): LocalBusinessAddress {
  return {
    streetAddress:   pickString(obj, 'streetAddress'),
    addressLocality: pickString(obj, 'addressLocality'),
    addressRegion:   pickString(obj, 'addressRegion'),
    postalCode:      pickString(obj, 'postalCode'),
  }
}

/** The parsed-JSON-LD route: a well-formed `ListItem > LocalBusiness` node. */
function localBusinessFromParsed(parsed: unknown[]): LocalBusiness | null {
  for (const b of parsed) {
    if (!isRecord(b) || b['@type'] !== 'ListItem' || !isRecord(b.item)) continue
    const item = b.item
    if (item['@type'] !== 'LocalBusiness') continue
    const name = pickString(item, 'name')
    if (!name) continue
    return {
      name,
      telephone: pickString(item, 'telephone'),
      address: addressFromRecord(isRecord(item.address) ? item.address : {}),
    }
  }
  return null
}

/**
 * The raw-source fallback route, for a block whose unescaped quotes broke
 * JSON.parse — see this function's own header comment on `jsonLd()`.
 */
function localBusinessFromRawSource(src: string): LocalBusiness | null {
  const grab = (key: string): string | null =>
    src.match(new RegExp(String.raw`"${key}"\s*:\s*"([^"]*)"`))?.[1]?.trim() || null
  const name = src.match(/"@type"\s*:\s*"LocalBusiness"\s*,\s*"name"\s*:\s*"([^"]*)"/)?.[1]?.trim()
  if (!name) return null
  return {
    name,
    telephone: grab('telephone'),
    address: {
      streetAddress:   grab('streetAddress'),
      addressLocality: grab('addressLocality'),
      addressRegion:   grab('addressRegion'),
      postalCode:      grab('postalCode'),
    },
  }
}

/** The ListItem>LocalBusiness node: clean legal name, phone, full postal address. */
function localBusiness({ parsed, src }: JsonLd): LocalBusiness | null {
  return localBusinessFromParsed(parsed) ?? localBusinessFromRawSource(src)
}

/** `<section id='x'>…</section>` — the id is single- OR double-quoted on live pages. */
function sectionHtml(html: string, id: string): string | null {
  const esc = id.replace(/[-/\\^$*+?.()|[\]{}]/g, String.raw`\$&`)
  return html.match(new RegExp(String.raw`<section\s+id=["']${esc}["'][\s\S]*?<\/section>`, 'i'))?.[0] ?? null
}

/** The `<p class="data-point">VALUE</p><p class="data-label">LABEL</p>` pairs in a section. */
function dataPoints(markup: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!markup) return out
  const re = /<p[^>]*data-point[^>]*>([^<]*)<\/p>\s*<p[^>]*data-label[^>]*>([^<]*)<\/p>/gi
  for (const m of markup.matchAll(re)) {
    out[decode(m[2]!).trim().toLowerCase()] = decode(m[1]!).trim()
  }
  return out
}

interface Metrics { properties: number | null; adr: number | null; occupancy: number | null }

/**
 * One metrics block. `sm` is the manager's self-reported numbers, `airbnb`/
 * `vrbo` are scraped listing counts — kept apart on purpose, since a manager
 * claiming 93 against 89 listed is a different signal from one claiming 300.
 */
function metricsFrom(html: string, id: string): Metrics | null {
  const dp = dataPoints(sectionHtml(html, id))
  const pick = (...keys: string[]): string | undefined => keys.map((k) => dp[k]).find((v) => v != null)
  const m: Metrics = {
    properties: num(pick('properties')),
    adr:        num(pick('average daily rate', 'average annual daily rate')),
    occupancy:  num(pick('average occupancy', 'average annual occupancy')),
  }
  return m.properties == null && m.adr == null && m.occupancy == null ? null : m
}

interface HeaderStats {
  headquarters: string | null
  founded_year: number | null
  employees_full_time: number | null
  properties_total: number | null
  markets_served: number | null
}

const HEADER_LABELS = [
  'Headquarters', 'Founded In', 'Number of Full Time Employees',
  'Total managed properties', 'Markets Served',
]

/**
 * The `#member-header-details` stat strip. Absent entirely on stub profiles.
 *
 * The stat strip is one run-on string: reading
 * `/([\d,]+)\s+total\s+managed\s+propert/` out of stripped text captures the
 * EMPLOYEE count, because the strip renders as "… Full Time Employees 14
 * Total managed properties 95". Every reader here anchors on the LABEL, never
 * on a number preceding one.
 */
function headerStats(html: string): Partial<HeaderStats> {
  const i = html.indexOf('id="member-header-details"')
  if (i < 0) return {}
  const text = stripTags(html.slice(i, i + 6000))
  const n = (label: string): number | null => num(text.match(new RegExp(String.raw`${label}\s+([\d,]+)`, 'i'))?.[1])
  const stop = String.raw`${HEADER_LABELS.join('|')}|\d+ homeowner views|Save to My Lists`
  return {
    headquarters: text.match(new RegExp(String.raw`Headquarters\s+(.+?)(?=\s+(?:${stop})|$)`, 'i'))?.[1] ?? null,
    founded_year: n('Founded In'),
    employees_full_time: n('Number of Full Time Employees'),
    properties_total: n('Total managed properties'),
    markets_served: n('Markets Served'),
  }
}

interface MarketCity { city: string; properties: number | null }
interface Market { state: string; properties: number | null; cities: MarketCity[] }

const COUNT_IN_PLACE = /^([\d,]+)(?: Propert(?:y|ies))? in (.+)$/i

/** "95 Properties in Tennessee" / "81 in Gatlinburg" -> { properties, place }. */
function parseCountInPlace(raw: string): { place: string; properties: number | null } | null {
  const m = COUNT_IN_PLACE.exec(decode(raw).replace(/\s+/g, ' ').trim())
  return m ? { place: m[2]!, properties: num(m[1]) } : null
}

/** `<h4>95 Properties in Tennessee</h4>` + `<p>81 in Gatlinburg</p>` city rows. */
function marketsServed(html: string): Market[] {
  const sec = sectionHtml(html, 'markets_served')
  if (!sec) return []
  const out: Market[] = []
  for (const m of sec.matchAll(/<h4[^>]*>([^<]*)<\/h4>([\s\S]*?)(?=<h4|$)/gi)) {
    const head = parseCountInPlace(m[1]!)
    if (!head) continue
    const cities = [...m[2]!.matchAll(/<p[^>]*>([^<]*)<\/p>/g)]
      .map((c) => parseCountInPlace(c[1]!))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({ city: c.place, properties: c.properties }))
    out.push({ state: head.place, properties: head.properties, cities })
  }
  return out
}

// CDNs, socials and OTAs — anything here is never the company's own site.
const BLOCKED_HOST_LABELS = new Set([
  'comparent', 'optimizecdn', 'cloudfront', 'akamai', 'fbcdn', 'facebook', 'instagram',
  'twitter', 'x', 'linkedin', 'youtube', 'tiktok', 'google', 'googleapis', 'gstatic',
  'googletagmanager', 'doubleclick', 'airbnb', 'vrbo', 'homeaway', 'booking', 'expedia',
  'yelp', 'pinterest', 'apple', 'schema', 'w3', 'jquery', 'bootstrapcdn', 'fontawesome',
  'jsdelivr', 'unpkg', 'cdnjs', 'cloudflare', 'clearbit', 'gravatar', 'hotjar',
])

const BLOCKED_HOST_SUFFIXES = [
  'r2.dev', 'b-cdn.net', 'amazonaws.com', 'blob.core.windows.net', 'imgix.net', 'wp.com',
]

/** A CDN, social network, OTA or object store — never the company's own site. */
function notACompanySite(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return true
  return h.split('.').some((label) => BLOCKED_HOST_LABELS.has(label))
}

// Words that carry no identity — every third company in the directory has them.
const GENERIC_NAME_TOKENS = new Set([
  'vacation', 'vacations', 'rental', 'rentals', 'property', 'properties', 'management',
  'managements', 'services', 'company', 'group', 'cabin', 'cabins', 'chalet', 'chalets',
  'condo', 'condos', 'home', 'homes', 'house', 'houses', 'lodging', 'resort', 'resorts',
  'realty', 'estate', 'agency', 'partners', 'holdings', 'llc', 'inc', 'corp', 'the', 'and',
])

/**
 * Does this host plausibly belong to this company?
 *
 * The bare "first external link that isn't a CDN" rule is not safe: on a
 * profile with no outbound CTA the only external links are comparent's OWN
 * infrastructure, and it once returned an R2 bucket (pub-<hash>.r2.dev) as a
 * company's website. A wrong domain is worse than a blank one — it is the
 * join key everything downstream keys on — so this only fires on a real
 * name-to-domain overlap.
 */
function domainMatchesName(hostname: string, companyName: string | null): boolean {
  const label = hostname.replace(/^www\./, '').split('.')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!label) return false
  const tokens = (companyName ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_NAME_TOKENS.has(t))
  return tokens.some((t) => label.includes(t))
}

interface WebsiteResult { url: string | null; source: 'utm_cta' | 'clearbit_logo' | 'name_match_asset' | null }

/** Website, best source first. Provenance is returned because the three routes are not equally trustworthy. */
function extractWebsite(html: string, companyName: string | null): WebsiteResult {
  // 1. the "Visit Website" CTA — comparent tags outbound links with its own utm.
  for (const h of hrefs(html)) {
    if (!/utm_source=comparent/i.test(h)) continue
    const u = safeUrl(h)
    if (!u || /(^|\.)comparent\.com$/.test(u.hostname)) continue
    return { url: u.origin + (u.pathname === '/' ? '' : u.pathname), source: 'utm_cta' }
  }
  // 2. stub profiles have no CTA, but their logo is proxied through clearbit,
  //    which keys on the real company domain: logo.clearbit.com/example.com
  const cb = html.match(/logo\.clearbit\.com\\?\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1]
  if (cb) return { url: `https://${cb}`, source: 'clearbit_logo' }
  // 3. last resort: any absolute URL on the page whose host echoes the
  //    company name — a stub profile's About prose routinely hotlinks images
  //    straight off the company's own site, which is the only trace of the
  //    domain anywhere on the page.
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) {
    const u = safeUrl(decode(m[0]))
    if (!u || notACompanySite(u.hostname)) continue
    if (domainMatchesName(u.hostname, companyName)) return { url: u.origin, source: 'name_match_asset' }
  }
  return { url: null, source: null }
}

type PortfolioSource = 'header_total' | 'markets_served' | 'pm_supplied' | 'ota_listings' | null

/** Portfolio size, most authoritative source first — each labelled, never blended. */
function resolvePortfolio(
  head: Partial<HeaderStats>,
  markets: Market[],
  supplied: Metrics | null,
  airbnb: Metrics | null,
  vrbo: Metrics | null,
): { value: number | null; source: PortfolioSource } {
  if (head.properties_total != null) return { value: head.properties_total, source: 'header_total' }
  const marketSum = markets.reduce((a, m) => a + (m.properties ?? 0), 0)
  if (marketSum > 0) return { value: marketSum, source: 'markets_served' }
  if (supplied?.properties != null) return { value: supplied.properties, source: 'pm_supplied' }
  const listed = Math.max(airbnb?.properties ?? 0, vrbo?.properties ?? 0)
  if (listed > 0) return { value: listed, source: 'ota_listings' }
  return { value: null, source: null }
}

/** `/str/<state>/<city>/<slug>` — recovers the state when addressRegion is blank. */
function stateFromUrl(url: string): string | null {
  const segs = url.split('/').filter(Boolean)
  const s = segs[0] === 'https:' && segs[2] === 'str' ? segs[3] : null
  return s && /^[a-z]{2}$/i.test(s) ? s.toUpperCase() : null
}

/** Fallback name only — the <title> carries " in City, ST - Comparent". */
function titleName(html: string): string | null {
  const t = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim()
  return t.replace(/[-|] ?Comparent$/i, '').trim()
    .replace(/ in [^,]+, [A-Z]{2}$/, '').trim() || null
}

const normalizePhone = (p: string | null): string | null => {
  const d = String(p ?? '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return d.length === 10 ? d : (d || null)
}

export interface ComparentExtractedProfile {
  company_name: string | null
  website: string | null
  website_source: WebsiteResult['source']
  domain: string | null
  phone: string | null
  city: string | null
  state: string | null
  portfolio_size: number | null
  portfolio_size_source: PortfolioSource
}

/**
 * Every field this module extracts from one comparent.com profile page.
 * Mirrors scripts/prospecting/comparent-crawl.mjs's `extractProfile()`, but
 * returns only the fields that map onto prospect_accounts columns — see this
 * file's header comment for why this is a parallel port and not a shared import.
 */
export function extractProfile(html: string, url: string): ComparentExtractedProfile {
  const ld = jsonLd(html)
  const biz = localBusiness(ld)
  const addr = biz?.address ?? { streetAddress: null, addressLocality: null, addressRegion: null, postalCode: null }
  const head = headerStats(html)
  const markets = marketsServed(html)
  const supplied = metricsFrom(html, 'sm-supplied')
  const airbnb = metricsFrom(html, 'airbnb')
  const vrbo = metricsFrom(html, 'vrbo')
  const companyName = biz?.name?.trim() || titleName(html)
  const site = extractWebsite(html, companyName)
  const size = resolvePortfolio(head, markets, supplied, airbnb, vrbo)

  return {
    company_name: companyName,
    website: site.url,
    website_source: site.source,
    domain: site.url ? new URL(site.url).hostname.replace(/^www\./, '') : null,
    phone: normalizePhone(biz?.telephone ?? null),
    city: addr.addressLocality?.trim() || null,
    state: addr.addressRegion?.trim() || stateFromUrl(url),
    portfolio_size: size.value,
    portfolio_size_source: size.source,
  }
}

/** robots.txt-disallowed paths on comparent.com — checked before every fetch. */
const DISALLOWED = ['/api/', '/writeareview', '/connect', '/filedata/cache/xml-sitemaps/']

export function isComparentUrlAllowed(url: string): boolean {
  const u = safeUrl(url)
  if (!u || !/(^|\.)comparent\.com$/.test(u.hostname)) return false
  return !DISALLOWED.some((d) => u.pathname.startsWith(d))
}
