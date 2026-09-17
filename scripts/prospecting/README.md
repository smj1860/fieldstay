# Tier 0a — comparent enrichment

Crawls the comparent.com directory profiles behind the city-page URLs already in the
master CSV's `Source` column, and joins the result back onto that CSV.

Node 20+. No dependencies.

## Layout

```
scripts/prospecting/   comparent-crawl.mjs, comparent-merge.mjs, README.md   (committed)
data/                  the master CSV + all crawl output                     (gitignored)
```

`data/` is in `.gitignore` — prospect lists, the page cache and the enriched output
never go in the repo.

```bash
export CSV=data/STR_Property_Managers_DB-MASTER.csv
export OUT=data/prospecting-out
```

## 1. Probe

```bash
node scripts/prospecting/comparent-crawl.mjs probe
```

Fetches three profiles (a filled one, a partly-filled one and a stub), saves the raw
HTML under `$OUT/probe/`, prints every extracted field and names whatever came back
null. Run it after any extractor change — it reads from the cache, so it costs no
requests.

## 2. Harvest profile URLs

```bash
node scripts/prospecting/comparent-crawl.mjs harvest
```

Reads the unique comparent city-page URLs out of `Source`, fetches each, collects every
company profile link. Writes `$OUT/profile-urls.json`. Last run: 450 city pages → **2,089
profile URLs**, against 1,766 comparent-sourced CSV rows — the surplus are companies the
city pages list that the CSV never captured, and they come out in `new-prospects.csv`.

## 3. Fetch the profiles

```bash
node scripts/prospecting/comparent-crawl.mjs profiles --sample 80   # coverage check
node scripts/prospecting/comparent-crawl.mjs profiles               # the real run
```

Use `--sample N` rather than `--limit N` for a pre-flight check: the harvest walks city
pages in CSV order, so the first N URLs are all one state and tell you nothing about
markup variance. `--sample` takes a deterministic pseudo-random spread of the whole list.

Resumable and cached — safe to interrupt, safe to re-run. Roughly 12–15 minutes per
thousand profiles at 800ms spacing and concurrency 2. Writes `$OUT/profiles.jsonl`.

## 3b. Re-extract after an extractor change

```bash
node scripts/prospecting/comparent-crawl.mjs reextract
```

**`profiles` will not pick up an extractor fix on its own** — it resumes by skipping any
URL already in the jsonl, so the old record survives untouched. `reextract` re-parses
every cached page and rewrites the jsonl from scratch. Zero requests.

## 4. Merge

```bash
node scripts/prospecting/comparent-merge.mjs
```

Joins profiles onto the CSV (by name slug, URL slug, and registrable domain), resolves
portfolio size, dedupes, flags brokerage suspects, and prints a before/after coverage
report. Writes `$OUT/enriched.csv`, `$OUT/new-prospects.csv`, `$OUT/unmatched.json`.

## What the extractors read

Rewritten 2026-09-17 against real saved markup. The pages are server-rendered
Blade/Tailwind — no hydration payload — and every field has a structural anchor, not a
prose pattern:

| Field | Source |
|---|---|
| `company_name`, `phone`, `street_address`/`city`/`state`/`zip` | `ld+json` `ListItem > LocalBusiness` |
| `founded_year`, `employees_full_time`, `properties_total`, `markets_served` | `#member-header-details` stat strip |
| `metrics_supplied` / `metrics_airbnb` / `metrics_vrbo` | `<section id="sm-supplied"\|"airbnb"\|"vrbo">` `data-point`/`data-label` pairs |
| `google`/`airbnb`/`vrbo`/`owner_rating` | `.star-container` pills |
| `markets`, `properties_local` | `<section id='markets_served'>` |
| `services` | `ld+json` `Service > hasOfferCatalog` |
| `website` | outbound CTA → clearbit logo host → name-matched asset URL |

### Five things that bit, kept here so they don't again

- **The stat strip is one run-on string.** Reading
  `/([\d,]+)\s+total\s+managed\s+propert/` out of stripped text captured the *employee*
  count, because the strip renders as `… Full Time Employees 14 Total managed properties 95`.
  Anchor on the label, never on a number preceding one.
- **Comparent emits unescaped quotes into its JSON-LD** (`we affectionately call "The
  Family Room"`), so `JSON.parse` throws on exactly the richest profiles. Every reader
  has a loose-regex fallback over the raw block, restricted to short quote-free fields.
- **The rating platform is an `<img>`, not a word.** Matching the literal string
  "Airbnb" found nothing; the label is `/images/logos/airbnb.webp`. Only "Owner" is text.
- **"First external link that isn't a CDN" returns comparent's own infrastructure.** It
  handed back an R2 bucket (`pub-<hash>.r2.dev`) as a company's website. The domain is
  the join key everything downstream uses, so a wrong one is worse than a blank one:
  that fallback now requires the host to echo the company name, and returns nothing
  otherwise.
- **The metrics section id is `sm-supplied`, not `sm`.**

### Two honest gaps, not bugs

- **About half of all profiles are stubs** — claimed but never filled in (`profile_depth`
  is `full`/`partial`/`stub`, median stripped text on a stub is ~1.4KB). They carry a
  name, an address and scraped OTA ratings, and nothing else. Scoring a stub's silence as
  a zero reads "didn't fill in the form" as "has no properties".
- **`properties_total` carries `properties_total_source`** — `header_total` (stated) is
  not the same claim as `ota_listings` (counted off Airbnb/VRBO) or `pm_supplied`
  (self-reported in a different widget). They are never blended.

## What it's careful about

- **robots.txt** — `/api/`, `/writeareview`, `/connect` and the sitemap cache dir are
  refused by the fetcher, not merely avoided.
- **Politeness** — concurrency 2, 800ms spacing, identified user-agent with a contact
  address, exponential backoff on 429/5xx.
- **Caching** — every fetched page lands in `$OUT/cache/` keyed by URL hash. Re-runs and
  extractor fixes cost zero requests.
- **Resumability** — `profiles` skips anything already in the jsonl.

robots.txt permits `/str/`, but their terms of service are a separate question from
robots — worth a read before a full run.
