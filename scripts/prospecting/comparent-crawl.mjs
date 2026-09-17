#!/usr/bin/env node
/**
 * comparent-crawl.mjs — Tier 0a enrichment for the FieldStay prospecting engine.
 *
 * Two stages:
 *   1. harvest  — read the unique comparent city-page URLs out of the master CSV's
 *                 Source column, fetch each, and collect company profile URLs.
 *   2. profiles — fetch each profile page and extract the ledger fields.
 *
 * Zero dependencies. Node 20+ (uses built-in fetch).
 *
 * Politeness: serial-ish (CONCURRENCY=2), 800ms spacing, identified user-agent,
 * on-disk cache so re-runs cost nothing, honours the disallowed paths in
 * comparent.com/robots.txt (/api/, /writeareview, /connect).
 *
 * Usage:
 *   node comparent-crawl.mjs probe                 # fetch 3 profiles, dump raw HTML + extraction report
 *   node comparent-crawl.mjs harvest               # stage 1
 *   node comparent-crawl.mjs profiles              # stage 2
 *   node comparent-crawl.mjs profiles --limit 50   # stage 2, first 50 only
 *
 * Env:
 *   CSV=path/to/master.csv   (default ./STR_Property_Managers_DB-MASTER.csv)
 *   OUT=./out                (cache + outputs)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseCSV } from './csv.mjs';

const CSV = process.env.CSV || './STR_Property_Managers_DB-MASTER.csv';
const OUT = process.env.OUT || './out';
const CACHE = path.join(OUT, 'cache');
const UA =
  'FieldStayResearchBot/0.1 (+https://fieldstay.app; contact: stephen@fieldstay.app)';

const CONCURRENCY = 2;
const DELAY_MS = 800;
const MAX_RETRIES = 3;

const DISALLOWED = ['/api/', '/writeareview', '/connect', '/filedata/cache/xml-sitemaps/'];

fs.mkdirSync(CACHE, { recursive: true });

// ------------------------------------------------------------------- fetching

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(url) {
  // sha256, not sha1 — a cache key needs no cryptographic strength, but a weak
  // hash fails SonarCloud's security rating and the swap is free. NOTE: this
  // changed the key, so a cache written before 2026-09-17 is orphaned.
  return path.join(CACHE, `${crypto.createHash('sha256').update(url).digest('hex')}.html`);
}

function allowed(url) {
  return !DISALLOWED.some((d) => new URL(url).pathname.startsWith(d));
}

async function fetchCached(url) {
  if (!allowed(url)) throw new Error(`robots-disallowed: ${url}`);
  const cp = cachePath(url);
  if (fs.existsSync(cp)) return { html: fs.readFileSync(cp, 'utf8'), cached: true };

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { html: null, status: res.status, cached: false };
      const html = await res.text();
      fs.writeFileSync(cp, html);
      await sleep(DELAY_MS);
      return { html, cached: false };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (attempt + 1)); // backoff
    }
  }
  throw lastErr;
}

/** Run tasks with a small concurrency cap, logging progress. */
async function pool(items, worker, label) {
  const results = [];
  let idx = 0, done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: String(e?.message || e) }; }
      if (++done % 25 === 0 || done === items.length) {
        process.stderr.write(`  ${label}: ${done}/${items.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

// ------------------------------------------------------------------ extractors

const NAMED_ENTITIES = {
  '&amp;': '&', '&apos;': "'", '&quot;': '"', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
};

const decode = (s) =>
  s.replace(/&#(\d+);|&[a-z]+;/gi, (m, dec) =>
    (dec === undefined ? (NAMED_ENTITIES[m.toLowerCase()] ?? m) : String.fromCodePoint(Number(dec))));

const RAW_TEXT_TAGS = ['script', 'style'];

/** The earliest `<script`/`<style` at or after `from`, or null. */
function nextRawTextOpen(low, from) {
  let best = null;
  for (const tag of RAW_TEXT_TAGS) {
    const at = low.indexOf(`<${tag}`, from);
    if (at >= 0 && (best === null || at < best.at)) best = { tag, at };
  }
  return best;
}

/** Drops <script>/<style> bodies by index scan — no backtracking, linear. */
function dropRawTextElements(html) {
  const low = html.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const open = nextRawTextOpen(low, i);
    if (!open) return out + html.slice(i);
    out += `${html.slice(i, open.at)} `;
    const close = low.indexOf(`</${open.tag}`, open.at);
    const after = close < 0 ? -1 : low.indexOf('>', close);
    if (after < 0) return out;
    i = after + 1;
  }
}

const stripTags = (html) =>
  decode(dropRawTextElements(html).replace(/<[^<>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function hrefs(html) {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => decode(m[1]));
}

const safeUrl = (h) => { try { return new URL(h); } catch { return null; } };

/** Linear trailing-slash strip. `/\/+$/` backtracks on a run of slashes. */
function stripTrailingSlash(str) {
  let end = str.length;
  while (end > 0 && str[end - 1] === '/') end -= 1;
  return str.slice(0, end);
}

const num = (s) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[,$%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Stage 1: profile links on a city page. */
function extractProfileLinks(html, baseUrl) {
  const out = new Set();
  for (const h of hrefs(html)) {
    const u = safeUrl(new URL(h, baseUrl).href);
    if (!u || !/(^|\.)comparent\.com$/.test(u.hostname)) continue;
    const p = stripTrailingSlash(u.pathname);
    // /str/<state>/<city>/<company>  (4 segments) or /united-states/<city>/<company> (3)
    const segs = p.split('/').filter(Boolean);
    const isStrProfile = segs[0] === 'str' && segs.length === 4;
    const isUsProfile = segs[0] === 'united-states' && segs.length === 3;
    if (isStrProfile || isUsProfile) out.add(u.origin + p);
  }
  return [...out];
}

// ---------------------------------------------------- structural page readers
//
// Everything below is anchored on markup verified against real saved pages in
// $OUT/probe/ (2026-09-17), not on guessed prose. The page is server-rendered
// Blade/Tailwind — no hydration payload — and carries four application/ld+json
// blocks, a header stat strip, and id'd <section> blocks of data-point pairs.
// Prefer those over scanning the flattened text: the first cut of this file read
// `/([\d,]+)\s+total\s+managed\s+propert/` out of stripped text and captured the
// EMPLOYEE count, because the strip renders as
// "... Full Time Employees 14 Total managed properties 95".

const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Every application/ld+json block, parsed where possible plus the raw source.
 *
 * The raw source is not a convenience: comparent emits prose into JSON-LD WITHOUT
 * escaping the quotes in it (an answer reading: we affectionately call "The Family
 * Room"), so JSON.parse throws on exactly the richest profiles. Every reader below
 * therefore has a loose regex fallback over `src`, restricted to short quote-free
 * fields where a `[^"]*` capture is safe.
 */
function jsonLd(html) {
  const parsed = [];
  let src = '';
  for (const m of html.matchAll(LD_RE)) {
    const raw = m[1].trim();
    src += `${raw}\n`;
    try { parsed.push(JSON.parse(raw)); } catch { /* unescaped quotes — loose readers cover it */ }
  }
  return { parsed, src };
}

/** The ListItem>LocalBusiness node: clean legal name, phone, full postal address. */
function localBusiness({ parsed, src }) {
  for (const b of parsed) {
    const item = b?.['@type'] === 'ListItem' ? b.item : null;
    if (item?.['@type'] === 'LocalBusiness' && item.name) return item;
  }
  const grab = (key) => src.match(new RegExp(String.raw`"${key}"\s*:\s*"([^"]*)"`))?.[1]?.trim() || null;
  const name = src.match(/"@type"\s*:\s*"LocalBusiness"\s*,\s*"name"\s*:\s*"([^"]*)"/)?.[1]?.trim();
  if (!name) return null;
  return {
    name,
    telephone: grab('telephone'),
    address: {
      streetAddress: grab('streetAddress'),
      addressLocality: grab('addressLocality'),
      addressRegion: grab('addressRegion'),
      postalCode: grab('postalCode'),
    },
  };
}

/** Exact service names from the Service node's (doubly nested) OfferCatalog. */
function offerCatalogServices({ parsed, src }) {
  const svc = parsed.find((b) => b?.['@type'] === 'Service');
  const names = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (Array.isArray(n?.itemListElement)) walk(n.itemListElement);
      if (Array.isArray(n?.itemOffered?.itemListElement)) walk(n.itemOffered.itemListElement);
      const name = n?.itemOffered?.name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  };
  walk(svc?.hasOfferCatalog?.itemListElement);
  if (!names.length) {
    const re = /"itemOffered"\s*:\s*\{\s*"@type"\s*:\s*"Service"\s*,\s*"name"\s*:\s*"([^"]*)"/g;
    for (const m of src.matchAll(re)) if (m[1].trim()) names.push(m[1].trim());
  }
  return [...new Set(names.map((n) => n.trim()))];
}

/**
 * Answers the company filled in on the 10-question owner FAQ.
 *
 * Read from the raw JSON-LD rather than the parsed tree, since this is the block
 * whose prose carries the unescaped quotes that break JSON.parse. Each answer is
 * bounded by the literal `"}}` that closes its Answer node, so an inner quote is
 * harmless.
 */
function faqAnswers({ src }) {
  const out = {};
  const re = /"name":"([\s\S]*?)","acceptedAnswer":\{"@type":"Answer","text":"([\s\S]*?)"\}\}/g;
  for (const m of src.matchAll(re)) {
    const answer = m[2].trim();
    if (answer) out[m[1].trim()] = answer;
  }
  return out;
}

/** `<section id='x'>…</section>` — the id is single- OR double-quoted on live pages. */
function sectionHtml(html, id) {
  const esc = id.replace(/[-/\\^$*+?.()|[\]{}]/g, String.raw`\$&`);
  return html.match(new RegExp(String.raw`<section\s+id=["']${esc}["'][\s\S]*?<\/section>`, 'i'))?.[0] ?? null;
}

/** The `<p class="data-point">VALUE</p><p class="data-label">LABEL</p>` pairs in a section. */
function dataPoints(markup) {
  const out = {};
  if (!markup) return out;
  const re = /<p[^>]*data-point[^>]*>([^<]*)<\/p>\s*<p[^>]*data-label[^>]*>([^<]*)<\/p>/gi;
  for (const m of markup.matchAll(re)) {
    out[decode(m[2]).trim().toLowerCase()] = decode(m[1]).trim();
  }
  return out;
}

/**
 * One metrics block. `sm` is the manager's self-reported numbers, `airbnb`/`vrbo`
 * are scraped listing counts — kept apart on purpose, since a manager claiming 93
 * against 89 listed is a different signal from one claiming 300.
 */
function metricsFrom(html, id) {
  const dp = dataPoints(sectionHtml(html, id));
  const pick = (...keys) => keys.map((k) => dp[k]).find((v) => v != null) ?? null;
  const m = {
    properties: num(pick('properties')),
    adr: num(pick('average daily rate', 'average annual daily rate')),
    occupancy: num(pick('average occupancy', 'average annual occupancy')),
  };
  return m.properties == null && m.adr == null && m.occupancy == null ? null : m;
}

const HEADER_LABELS = [
  'Headquarters', 'Founded In', 'Number of Full Time Employees',
  'Total managed properties', 'Markets Served',
];

/** The `#member-header-details` stat strip. Absent entirely on stub profiles. */
function headerStats(html) {
  const i = html.indexOf('id="member-header-details"');
  if (i < 0) return {};
  const text = stripTags(html.slice(i, i + 6000));
  const n = (label) => num(text.match(new RegExp(String.raw`${label}\s+([\d,]+)`, 'i'))?.[1]);
  const stop = String.raw`${HEADER_LABELS.join('|')}|\d+ homeowner views|Save to My Lists`;
  return {
    headquarters: text.match(new RegExp(String.raw`Headquarters\s+(.+?)(?=\s+(?:${stop})|$)`, 'i'))?.[1] ?? null,
    founded_year: n('Founded In'),
    employees_full_time: n('Number of Full Time Employees'),
    properties_total: n('Total managed properties'),
    markets_served: n('Markets Served'),
  };
}

/**
 * The `.star-container` rating pills. The platform is named by a text
 * `.platform-icon` span ("Owner") OR by a logo filename (`/images/logos/vrbo.webp`)
 * — the logo case is why matching on the literal word "Airbnb" in page text found
 * nothing: the label is an <img>, not a string.
 */
function starRatings(html) {
  const out = {};
  for (const m of html.matchAll(/class="star-container[\s\S]{0,1200}?<\/div>/gi)) {
    const block = m[0];
    const label = block.match(/platform-icon[^>]*>\s*([A-Za-z]+)\s*</)?.[1]
      ?? block.match(/logos\/([a-z0-9_-]+)\.(?:webp|png|svg|jpe?g)/i)?.[1];
    const rating = Number(block.match(/class="font-bold"[^>]*>\s*([\d.]+)\s*</)?.[1]);
    if (!label || !Number.isFinite(rating)) continue;
    out[label.toLowerCase()] = { rating, reviews: num(block.match(/\(\s*([\d,]+)\s*\)/)?.[1]) };
  }
  return out;
}

const COUNT_IN_PLACE = /^([\d,]+)(?: Propert(?:y|ies))? in (.+)$/i;

/** "95 Properties in Tennessee" / "81 in Gatlinburg" -> { properties, place }. */
function parseCountInPlace(raw) {
  const m = COUNT_IN_PLACE.exec(decode(raw).replace(/\s+/g, ' ').trim());
  return m ? { place: m[2], properties: num(m[1]) } : null;
}

/** `<h4>95 Properties in Tennessee</h4>` + `<p>81 in Gatlinburg</p>` city rows. */
function marketsServed(html) {
  const sec = sectionHtml(html, 'markets_served');
  if (!sec) return [];
  const out = [];
  for (const m of sec.matchAll(/<h4[^>]*>([^<]*)<\/h4>([\s\S]*?)(?=<h4|$)/gi)) {
    const head = parseCountInPlace(m[1]);
    if (!head) continue;
    const cities = [...m[2].matchAll(/<p[^>]*>([^<]*)<\/p>/g)]
      .map((c) => parseCountInPlace(c[1])).filter(Boolean)
      .map((c) => ({ city: c.place, properties: c.properties }));
    out.push({ state: head.place, properties: head.properties, cities });
  }
  return out;
}

// CDNs, socials and OTAs — anything here is never the company's own site. The
// first cut had no CDN entries and so returned optimizecdn.com (comparent's OWN
// asset host) as the "website" for every profile lacking an outbound CTA.
const BLOCKED_HOST_LABELS = new Set([
  'comparent', 'optimizecdn', 'cloudfront', 'akamai', 'fbcdn', 'facebook', 'instagram',
  'twitter', 'x', 'linkedin', 'youtube', 'tiktok', 'google', 'googleapis', 'gstatic',
  'googletagmanager', 'doubleclick', 'airbnb', 'vrbo', 'homeaway', 'booking', 'expedia',
  'yelp', 'pinterest', 'apple', 'schema', 'w3', 'jquery', 'bootstrapcdn', 'fontawesome',
  'jsdelivr', 'unpkg', 'cdnjs', 'cloudflare', 'clearbit', 'gravatar', 'hotjar',
]);

const BLOCKED_HOST_SUFFIXES = [
  'r2.dev', 'b-cdn.net', 'amazonaws.com', 'blob.core.windows.net', 'imgix.net', 'wp.com',
];

/**
 * A CDN, social network, OTA or object store — never the company's own site.
 *
 * This was one regex of the shape `(^|\.)a|b$`, which mixed two anchors under a
 * top-level alternation: the precedence a reader (and SonarCloud) has to guess
 * at. A deny-list is a set membership test, so it is written as one.
 */
function notACompanySite(hostname) {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return true;
  return h.split('.').some((label) => BLOCKED_HOST_LABELS.has(label));
}

// Words that carry no identity — every third company in the directory has them.
const GENERIC_NAME_TOKENS = new Set([
  'vacation', 'vacations', 'rental', 'rentals', 'property', 'properties', 'management',
  'managements', 'services', 'company', 'group', 'cabin', 'cabins', 'chalet', 'chalets',
  'condo', 'condos', 'home', 'homes', 'house', 'houses', 'lodging', 'resort', 'resorts',
  'realty', 'estate', 'agency', 'partners', 'holdings', 'llc', 'inc', 'corp', 'the', 'and',
]);

/**
 * Does this host plausibly belong to this company?
 *
 * The bare "first external link that isn't a CDN" rule is not safe here: on a
 * profile with no outbound CTA the only external links are comparent's OWN
 * infrastructure, and it happily returned an R2 bucket
 * (pub-<hash>.r2.dev) as SkyRun Estes Park's website. A wrong domain is worse
 * than a blank one — it is the join key everything downstream keys on — so this
 * fallback only fires on a real name-to-domain overlap, and returns nothing
 * otherwise.
 */
function domainMatchesName(hostname, companyName) {
  const label = hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!label) return false;
  const tokens = (companyName ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_NAME_TOKENS.has(t));
  return tokens.some((t) => label.includes(t));
}

/**
 * Website, best source first. Returned with its provenance because the three
 * routes are not equally trustworthy and the merge needs to say which it used.
 */
function extractWebsite(html, companyName) {
  // 1. the "Visit Website" CTA — comparent tags outbound links with its own utm.
  for (const h of hrefs(html)) {
    if (!/utm_source=comparent/i.test(h)) continue;
    const u = safeUrl(h);
    if (!u || /(^|\.)comparent\.com$/.test(u.hostname)) continue;
    return { url: u.origin + (u.pathname === '/' ? '' : u.pathname), source: 'utm_cta' };
  }
  // 2. stub profiles have no CTA, but their logo is proxied through clearbit,
  //    which keys on the real company domain: logo.clearbit.com/example.com
  const cb = html.match(/logo\.clearbit\.com\\?\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1];
  if (cb) return { url: `https://${cb}`, source: 'clearbit_logo' };
  // 3. last resort: any absolute URL on the page whose host echoes the company
  //    name. Not just hrefs — a stub profile's About prose routinely hotlinks
  //    images straight off the company's own site
  //    (<img src="https://www.staywithstylescottsdale.com/wp-content/...">),
  //    which is the only trace of the domain anywhere on the page.
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) {
    const u = safeUrl(decode(m[0]));
    if (!u || notACompanySite(u.hostname)) continue;
    if (domainMatchesName(u.hostname, companyName)) return { url: u.origin, source: 'name_match_asset' };
  }
  return { url: null, source: null };
}

/** Portfolio size, most authoritative source first — each labelled, never blended. */
function resolvePortfolio(head, markets, supplied, airbnb, vrbo) {
  if (head.properties_total != null) return { value: head.properties_total, source: 'header_total' };
  const marketSum = markets.reduce((a, m) => a + (m.properties ?? 0), 0);
  if (marketSum > 0) return { value: marketSum, source: 'markets_served' };
  if (supplied?.properties != null) return { value: supplied.properties, source: 'pm_supplied' };
  const listed = Math.max(airbnb?.properties ?? 0, vrbo?.properties ?? 0);
  if (listed > 0) return { value: listed, source: 'ota_listings' };
  return { value: null, source: null };
}

/** Properties in the city this profile is listed under — the true local density. */
function localCount(markets, locality, url) {
  const slugCity = (url.split('/').filter(Boolean)[4] ?? '').replaceAll('-', ' ');
  const want = (locality || slugCity).toLowerCase().trim();
  if (!want) return null;
  for (const m of markets) {
    const hit = m.cities.find((c) => c.city.toLowerCase() === want);
    if (hit) return hit.properties;
  }
  return null;
}

/** own | contract | null — exact service names first, FAQ prose only as a fallback. */
function crewModel(services, faqText) {
  if (/in[- ]house cleaning/i.test(services.join(' | '))) return 'own';
  if (/in[- ]house (?:cleaning|housekeeping|laundry|property maintenance|maintenance)|our own (?:housekeep|cleaning|clean)|employ(?:ed|s)? (?:our own )?(?:housekeep|cleaner)/i.test(faqText)) return 'own';
  if (/cleaning partner|third[- ]party clean|contract(?:ed)? clean|vendor clean|independent contractor clean|partner with local clean/i.test(faqText)) return 'contract';
  return null;
}

/** Crude on purpose — surfaces realty firms for a human look, never decides. */
function businessType(name, services) {
  const n = (name ?? '').toLowerCase();
  const strSignal = /vacation rental|short[- ]term|cabin|chalet|condo|beach|lodge|lodging|resort|getaway|retreat|stays?\b/.test(n)
    || services.length > 0;
  const brokerSignal = /realt|brokerage|real estate|re\/max|keller williams|coldwell|century 21|sotheby/.test(n);
  return brokerSignal && !strSignal ? 'brokerage_suspect' : 'str_manager';
}

/**
 * How much of a profile actually exists. A stub is not a data-quality failure —
 * roughly a third of directory entries are claimed-but-unfilled — but scoring a
 * stub the same as a filled profile reads its silence as a zero.
 */
function profileDepth(rec) {
  const filled = [rec.properties_total, rec.founded_year, rec.employees_full_time,
    rec.services.length || null, rec.metrics_supplied].filter((v) => v != null).length;
  if (filled >= 3) return 'full';
  return filled >= 1 ? 'partial' : 'stub';
}

/** `/str/<state>/<city>/<slug>` — recovers the state when addressRegion is blank. */
function stateFromUrl(url) {
  const segs = url.split('/').filter(Boolean);
  const s = segs[0] === 'https:' && segs[2] === 'str' ? segs[3] : null;
  return s && /^[a-z]{2}$/i.test(s) ? s.toUpperCase() : null;
}

/** Fallback name only — the <title> carries " in City, ST - Comparent". */
function titleName(html) {
  const t = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim();
  return t.replace(/[-|] ?Comparent$/i, '').trim()
    .replace(/ in [^,]+, [A-Z]{2}$/, '').trim() || null;
}

const normalizePhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : (d || null);
};

/** Stage 2: every field, from a profile page. */
function extractProfile(html, url) {
  const ld = jsonLd(html);
  const biz = localBusiness(ld);
  const addr = biz?.address ?? {};
  const head = headerStats(html);
  const markets = marketsServed(html);
  const supplied = metricsFrom(html, 'sm-supplied');
  const airbnb = metricsFrom(html, 'airbnb');
  const vrbo = metricsFrom(html, 'vrbo');
  const ratings = starRatings(html);
  const companyName = biz?.name?.trim() || titleName(html);
  const site = extractWebsite(html, companyName);
  const faq = faqAnswers(ld);
  const services = offerCatalogServices(ld);
  const size = resolvePortfolio(head, markets, supplied, airbnb, vrbo);

  const rec = {
    profile_url: url,
    company_name: companyName,
    website: site.url,
    website_source: site.source,
    domain: site.url ? new URL(site.url).hostname.replace(/^www\./, '') : null,
    phone: normalizePhone(biz?.telephone),
    street_address: addr.streetAddress?.trim() || null,
    city: addr.addressLocality?.trim() || null,
    state: addr.addressRegion?.trim() || stateFromUrl(url),
    zip: addr.postalCode?.trim() || null,
    headquarters: head.headquarters ?? null,
    founded_year: head.founded_year ?? null,
    employees_full_time: head.employees_full_time ?? null,
    markets_served: head.markets_served ?? (markets.length || null),
    properties_total: size.value,
    properties_total_source: size.source,
    properties_local: localCount(markets, addr.addressLocality, url),
    markets,
    metrics_supplied: supplied,
    metrics_airbnb: airbnb,
    metrics_vrbo: vrbo,
    google: ratings.google ?? null,
    airbnb: ratings.airbnb ?? null,
    vrbo: ratings.vrbo ?? null,
    owner_rating: ratings.owner ?? null,
    services,
    faq_answered: Object.keys(faq).length,
  };

  rec.address = [rec.street_address, rec.city, rec.state, rec.zip].filter(Boolean).join(', ') || null;
  rec.crew_model = crewModel(services, Object.values(faq).join(' '));
  rec.business_type_hint = businessType(rec.company_name, services);
  rec.profile_depth = profileDepth(rec);
  rec._text_len = stripTags(html).length;
  rec._missing = Object.entries({
    website: rec.website, properties_total: rec.properties_total,
    founded_year: rec.founded_year, employees_full_time: rec.employees_full_time,
  }).filter(([, v]) => v == null).map(([k]) => k);

  return rec;
}

// --------------------------------------------------------------------- stages

function cityUrlsFromCsv() {
  const { rows } = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const urls = new Set();
  for (const r of rows) {
    const s = (r['Source'] || '').trim();
    if (/^https?:\/\/(www\.)?comparent\.com\//i.test(s)) urls.add(stripTrailingSlash(s));
  }
  return { rows, cityUrls: [...urls] };
}

async function stageHarvest() {
  const { rows, cityUrls } = cityUrlsFromCsv();
  console.error(`CSV rows: ${rows.length} · unique comparent city pages: ${cityUrls.length}`);

  const found = new Map(); // profileUrl -> cityUrl
  await pool(cityUrls, async (u) => {
    const { html, status } = await fetchCached(u);
    if (!html) return { url: u, status };
    for (const p of extractProfileLinks(html, u)) if (!found.has(p)) found.set(p, u);
    return { url: u, n: found.size };
  }, 'city pages');

  const outFile = path.join(OUT, 'profile-urls.json');
  fs.writeFileSync(outFile, JSON.stringify([...found.keys()], null, 2));
  console.error(`\n✓ ${found.size} profile URLs → ${outFile}`);
}

/**
 * A deterministic sample. `--limit` takes the FIRST n, which on this list means
 * one state: the harvest walks city pages in CSV order. For a coverage check
 * before the full run that is the wrong n — use `--sample n`.
 */
function sampleUrls(urls, n) {
  const picked = [...urls];
  let seed = 20260917;
  for (let i = picked.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.slice(0, n);
}

async function stageProfiles(limit, sample) {
  const urls = JSON.parse(fs.readFileSync(path.join(OUT, 'profile-urls.json'), 'utf8'));
  let todo = urls;
  if (sample) todo = sampleUrls(urls, sample);
  else if (limit) todo = urls.slice(0, limit);
  const outFile = path.join(OUT, 'profiles.jsonl');
  const stream = fs.createWriteStream(outFile, { flags: 'a' });

  // resume: skip URLs already in the jsonl
  const seen = new Set();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).profile_url); } catch { /* ignore */ }
    }
  }
  const pending = todo.filter((u) => !seen.has(u));
  console.error(`profiles: ${todo.length} total, ${seen.size} already done, ${pending.length} to fetch`);

  const stats = { ok: 0, no_website: 0, failed: 0 };
  await pool(pending, async (u) => {
    const { html, status } = await fetchCached(u);
    if (!html) { stats.failed++; stream.write(JSON.stringify({ profile_url: u, error: `HTTP ${status}` }) + '\n'); return; }
    const rec = extractProfile(html, u);
    if (!rec.website) stats.no_website++; else stats.ok++;
    stream.write(JSON.stringify(rec) + '\n');
  }, 'profiles');

  stream.end();
  console.error(`\n✓ ${outFile}`);
  console.error(`  website found: ${stats.ok} · no website: ${stats.no_website} · failed: ${stats.failed}`);
}

/**
 * Re-parse every already-cached profile page, replacing profiles.jsonl.
 *
 * Without this, fixing an extractor does NOT reach rows already crawled: the
 * `profiles` stage resumes by skipping any URL already in the jsonl, so the old
 * (wrong) record survives. Costs zero requests — everything is read off disk.
 */
async function stageReextract() {
  const urls = JSON.parse(fs.readFileSync(path.join(OUT, 'profile-urls.json'), 'utf8'));
  const outFile = path.join(OUT, 'profiles.jsonl');
  const lines = [];
  const stats = { parsed: 0, uncached: 0, no_website: 0 };
  for (const u of urls) {
    const cp = cachePath(u);
    if (!fs.existsSync(cp)) { stats.uncached++; continue; }
    const rec = extractProfile(fs.readFileSync(cp, 'utf8'), u);
    if (!rec.website) stats.no_website++;
    stats.parsed++;
    lines.push(JSON.stringify(rec));
  }
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  console.error(`✓ re-extracted ${stats.parsed} cached profiles → ${outFile}`);
  console.error(`  not yet fetched: ${stats.uncached} · no website: ${stats.no_website}`);
}

async function stageProbe(limit) {
  // Deliberately mixes a filled profile with a stub: the stub is the case the
  // first cut of the extractors read as a parse failure rather than an empty
  // profile, and it is roughly a third of the directory.
  const FALLBACK = [
    'https://comparent.com/str/tn/gatlinburg/mountain-laurel-chalets-inc',
    'https://comparent.com/str/co/estes-park/skyrun-estes-park',
    'https://comparent.com/str/tn/gatlinburg/heartland-cabin-rentals',
  ];
  const pf = path.join(OUT, 'profile-urls.json');
  const n = limit || 3;
  const urls = fs.existsSync(pf)
    ? JSON.parse(fs.readFileSync(pf, 'utf8')).slice(0, n)
    : FALLBACK.slice(0, n);

  const dir = path.join(OUT, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const report = [];
  for (const u of urls) {
    const { html, status } = await fetchCached(u);
    const slug = u.split('/').pop();
    if (!html) { console.log(`\n=== ${u}\n  HTTP ${status}`); continue; }
    fs.writeFileSync(path.join(dir, `${slug}.html`), html);
    const rec = extractProfile(html, u);
    report.push(rec);
    console.log(`\n=== ${u}`);
    console.log(`  raw html: ${html.length} bytes -> ${path.join(dir, slug)}.html`);
    console.log(JSON.stringify(rec, null, 2));
  }

  const miss = {};
  for (const r of report) for (const k of r._missing) miss[k] = (miss[k] ?? 0) + 1;
  console.log(`\nprobed ${report.length} · depth: ${report.map((r) => r.profile_depth).join(', ')}`);
  console.log(`still missing: ${Object.keys(miss).length ? JSON.stringify(miss) : 'nothing'}`);
  console.log(`raw HTML kept in ${dir} — re-runs are served from the cache, so fixing an`);
  console.log('extractor and re-probing costs zero requests.');
}

// ----------------------------------------------------------------------- main

const cmd = process.argv[2];
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
const sampleArg = process.argv.indexOf('--sample');
const sample = sampleArg > -1 ? Number(process.argv[sampleArg + 1]) : 0;

const run = { probe: () => stageProbe(limit), harvest: stageHarvest, reextract: stageReextract, profiles: () => stageProfiles(limit, sample) }[cmd];
if (!run) {
  console.error('usage: node comparent-crawl.mjs <probe|harvest|profiles|reextract> [--limit N | --sample N]');
  process.exit(1);
}
try {
  await run();
} catch (e) {
  console.error('FATAL', e);
  process.exit(1);
}
