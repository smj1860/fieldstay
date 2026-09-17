#!/usr/bin/env node
/**
 * comparent-merge.mjs — join crawled comparent profiles back onto the master CSV.
 *
 * Also does the dedupe pass (91 duplicate company names, 42 duplicate domains in
 * the current file) and flags brokerage false-positives, because both have to
 * happen before anything writes to the ledger.
 *
 * Usage:
 *   node comparent-merge.mjs
 *
 * Reads : $CSV, $OUT/profiles.jsonl
 * Writes: $OUT/enriched.csv, $OUT/unmatched.json, and a coverage report to stdout
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseCSV, toCSV } from './csv.mjs';

const CSV = process.env.CSV || './STR_Property_Managers_DB-MASTER.csv';
const OUT = process.env.OUT || './out';

// --------------------------------------------------------------- normalizing

const slug = (s) =>
  (s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''`]/g, '')
    .replace(/\b(llc|inc|co|company|the|a)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, '-');

const bareDomain = (u) => {
  if (!u) return '';
  try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
};

const MULTI_PART_TLD = /\.(co|com|net|org|gov|ac)\.[a-z]{2}$/i;

/**
 * The registrable domain, for dedupe only — `domain` stays exactly as observed.
 * Comparent hands back the marketing host it was given, so the same company can
 * appear as both `azdesertvacations.com` and `join.azdesertvacations.com`; keyed
 * on the raw host those are two prospects and both get emailed.
 */
const rootDomain = (d) => {
  if (!d) return '';
  const parts = d.split('.');
  const keep = MULTI_PART_TLD.test(d) ? 3 : 2;
  return parts.length <= keep ? d : parts.slice(-keep).join('.');
};

/** parse "47-50", "~70 units", "206" → a number (midpoint for ranges) */
const parseSize = (s) => {
  const nums = String(s || '').match(/\d[\d,]*/g);
  if (!nums) return null;
  const v = nums.map((n) => Number(n.replace(/,/g, ''))).filter((n) => n > 0 && n < 100000);
  if (!v.length) return null;
  return v.length >= 2 ? Math.round((v[0] + v[1]) / 2) : v[0];
};

// ------------------------------------------------------------------- the join

const { rows } = parseCSV(fs.readFileSync(CSV, 'utf8'));

const profiles = fs.readFileSync(path.join(OUT, 'profiles.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((p) => p && !p.error);

// Index by URL slug, by company-name slug, and by registrable domain. The third
// key matters: the directory and the CSV disagree on legal suffixes and DBA
// names far more often than they disagree on a website.
const byUrlSlug = new Map(), byNameSlug = new Map(), byDomain = new Map();
for (const p of profiles) {
  const urlSlug = decodeURIComponent(p.profile_url.split('/').pop() || '');
  if (!byUrlSlug.has(slug(urlSlug))) byUrlSlug.set(slug(urlSlug), p);
  if (p.company_name && !byNameSlug.has(slug(p.company_name))) byNameSlug.set(slug(p.company_name), p);
  const rd = rootDomain(p.domain);
  if (rd && !byDomain.has(rd)) byDomain.set(rd, p);
}

// Snapshot what the CSV had BEFORE anything is written back. Deriving the
// "before" column from an origin flag instead undercounts it badly: the flag is
// only set on rows that matched a profile, so 1,209 rows that always had a phone
// reported as newly-enriched.
const before = {
  website: rows.filter((r) => r['Website']).length,
  phone: rows.filter((r) => r['Phone']).length,
  size: rows.filter((r) => parseSize(r['Portfolio Size (est.)'])).length,
};

const num = (v) => (v == null || v === '' ? '' : v);
const used = new Set();
const unmatched = [];
let matched = 0;

/** The profile for a CSV row: name slug first, then the row's own domain. */
function findProfile(r) {
  const s = slug(r['Company']);
  return byUrlSlug.get(s) || byNameSlug.get(s) || byDomain.get(rootDomain(bareDomain(r['Website']))) || null;
}

/** Everything the crawl adds to a row. Never overwrites a value already there. */
function applyProfile(r, p) {
  if (!r['Website'] && p.website) { r['Website'] = p.website; r['website_origin'] = 'comparent'; }
  else if (r['Website']) r['website_origin'] = 'original';
  if (!r['Phone'] && p.phone) { r['Phone'] = p.phone; r['phone_origin'] = 'comparent'; }
  else if (r['Phone']) r['phone_origin'] = 'original';

  r['domain'] = bareDomain(r['Website']);
  r['root_domain'] = rootDomain(r['domain']);
  r['comparent_url'] = p.profile_url;
  r['comparent_website_source'] = p.website_source ?? '';
  r['profile_depth'] = p.profile_depth ?? '';
  r['properties_exact'] = num(p.properties_total);
  r['properties_exact_source'] = p.properties_total_source ?? '';
  r['properties_local'] = num(p.properties_local);
  r['founded_year'] = num(p.founded_year);
  r['employees_ft'] = num(p.employees_ft ?? p.employees_full_time);
  r['markets_served'] = num(p.markets_served);
  r['crew_model'] = p.crew_model ?? '';
  r['services'] = (p.services || []).join('; ');
  r['faq_answered'] = num(p.faq_answered);
  r['google_rating'] = num(p.google?.rating);
  r['google_reviews'] = num(p.google?.reviews);
  r['airbnb_reviews'] = num(p.airbnb?.reviews);
  r['vrbo_reviews'] = num(p.vrbo?.reviews);
  r['owner_rating'] = num(p.owner_rating?.rating);
  r['owner_reviews'] = num(p.owner_rating?.reviews);
  r['adr'] = num(p.metrics_supplied?.adr ?? p.metrics_airbnb?.adr);
  r['occupancy'] = num(p.metrics_supplied?.occupancy ?? p.metrics_airbnb?.occupancy);
  r['business_type'] = p.business_type_hint ?? '';
  r['address'] = p.address ?? '';
}

for (const r of rows) {
  const p = findProfile(r);
  if (!p) {
    r['domain'] = bareDomain(r['Website']);
    r['root_domain'] = rootDomain(r['domain']);
    if (r['Website']) r['website_origin'] = 'original';
    unmatched.push({ company: r['Company'], city: r['City'], state: r['State'], website: r['Website'] });
    continue;
  }
  matched++;
  used.add(p.profile_url);
  applyProfile(r, p);
}

// resolved portfolio size: an exact count from the directory beats the estimate
for (const r of rows) {
  const exact = parseSize(r['properties_exact']);
  const est = parseSize(r['Portfolio Size (est.)']);
  r['portfolio_size'] = exact ?? est ?? '';
  r['portfolio_size_method'] = exact ? `comparent_${r['properties_exact_source'] || 'exact'}` : (est ? 'original_estimate' : '');
  if (exact && est && Math.abs(exact - est) / Math.max(exact, est) > 0.25) {
    r['size_conflict'] = `csv=${est} comparent=${exact}`;
  }
}

// ---------------------------------------------------------------- dedupe pass

const seenName = new Map(), seenDomain = new Map();
for (const r of rows) {
  const ns = slug(r['Company']), d = r['root_domain'];
  if (ns && seenName.has(ns)) r['dupe_of'] = seenName.get(ns);
  else if (ns) seenName.set(ns, r['Company']);
  if (!d) continue;
  if (seenDomain.has(d) && !r['dupe_of']) r['dupe_of'] = seenDomain.get(d);
  else if (!seenDomain.has(d)) seenDomain.set(d, r['Company']);
}

// ------------------------------------------------------------------- outputs

const extra = ['domain', 'root_domain', 'website_origin', 'phone_origin', 'comparent_url',
  'comparent_website_source', 'profile_depth', 'portfolio_size', 'portfolio_size_method',
  'properties_exact', 'properties_exact_source', 'properties_local', 'size_conflict',
  'founded_year', 'employees_ft', 'markets_served', 'crew_model', 'services', 'faq_answered',
  'google_rating', 'google_reviews', 'airbnb_reviews', 'vrbo_reviews', 'owner_rating',
  'owner_reviews', 'adr', 'occupancy', 'business_type', 'address', 'dupe_of'];
const header = [...Object.keys(rows[0]).filter((k) => !extra.includes(k)), ...extra];

fs.writeFileSync(path.join(OUT, 'enriched.csv'), toCSV(header, rows));
fs.writeFileSync(path.join(OUT, 'unmatched.json'), JSON.stringify(unmatched, null, 2));

// Profiles the city pages listed that the CSV never captured — net-new prospects,
// already enriched, at no extra crawl cost.
const csvDomains = new Set(rows.map((r) => r['root_domain']).filter(Boolean));
const csvNames = new Set(rows.map((r) => slug(r['Company'])).filter(Boolean));
const fresh = profiles.filter((p) => !used.has(p.profile_url)
  && !csvNames.has(slug(p.company_name))
  && !(p.domain && csvDomains.has(rootDomain(p.domain))));

const freshRows = fresh.map((p) => {
  const r = { Company: p.company_name, City: p.city, State: p.state, Website: p.website, Phone: p.phone,
    'Portfolio Size (est.)': '', Source: p.profile_url };
  applyProfile(r, p);
  r['portfolio_size'] = parseSize(r['properties_exact']) ?? '';
  r['portfolio_size_method'] = r['portfolio_size'] ? `comparent_${r['properties_exact_source']}` : '';
  return r;
});
const freshHeader = ['Company', 'City', 'State', 'Website', 'Phone', 'Portfolio Size (est.)', 'Source', ...extra]
  .filter((h, i, a) => a.indexOf(h) === i);
fs.writeFileSync(path.join(OUT, 'new-prospects.csv'), toCSV(freshHeader, freshRows));

// --------------------------------------------------------------------- report

const n = rows.length;
const pct = (c) => `${c} (${(c / n * 100).toFixed(1)}%)`;
const count = (f) => rows.filter(f).length;
const tally = (items, f) => Object.entries(items.reduce((a, x) => {
  const k = f(x) || '(none)'; a[k] = (a[k] ?? 0) + 1; return a;
}, {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');

const col = (s) => String(s).padEnd(16);

console.log(`
COVERAGE  —  ${n} CSV rows · ${profiles.length} profiles crawled · ${matched} row matches (${used.size} distinct profiles)

                           before          after
  website             ${col(pct(before.website))}${pct(count((r) => r['Website']))}
  phone               ${col(pct(before.phone))}${pct(count((r) => r['Phone']))}
  portfolio size      ${col(pct(before.size))}${pct(count((r) => r['portfolio_size']))}

  NEW FROM THE CRAWL
  exact property count      ${pct(count((r) => r['properties_exact'] !== '' && r['properties_exact'] != null))}
  properties in-market      ${pct(count((r) => r['properties_local'] !== '' && r['properties_local'] != null))}
  crew model                ${pct(count((r) => r['crew_model']))}
  full-time employees       ${pct(count((r) => r['employees_ft'] !== '' && r['employees_ft'] != null))}
  founded year              ${pct(count((r) => r['founded_year'] !== '' && r['founded_year'] != null))}
  services list             ${pct(count((r) => r['services']))}
  google reviews            ${pct(count((r) => r['google_reviews'] !== '' && r['google_reviews'] != null))}
  street address            ${pct(count((r) => r['address']))}

  PROVENANCE
  profile depth        ${tally(rows.filter((r) => r['comparent_url']), (r) => r['profile_depth'])}
  website discovered   ${tally(rows.filter((r) => r['website_origin'] === 'comparent'), (r) => r['comparent_website_source'])}
  size source          ${tally(rows.filter((r) => r['portfolio_size_method']), (r) => r['portfolio_size_method'])}

FLAGS
  brokerage suspects     ${count((r) => r['business_type'] === 'brokerage_suspect')}
  size conflicts >25%    ${count((r) => r['size_conflict'])}
  duplicates             ${count((r) => r['dupe_of'])}
  unmatched to a profile ${unmatched.length}
  net-new prospects      ${freshRows.length}

  → ${path.join(OUT, 'enriched.csv')}
  → ${path.join(OUT, 'new-prospects.csv')}
  → ${path.join(OUT, 'unmatched.json')}
`);
