/**
 * Turning a parsed spreadsheet into a plan of inserts and updates against
 * prospect_accounts.
 *
 * A LEAF module (only ./normalize and ./columns, both leaves) so the admin
 * import wizard runs it in the browser and scripts/import-prospects.ts runs
 * the identical code in node. That sharing is the point: the CLI's merge
 * policy and identity matching were each paid for with a real duplicate-row
 * incident, and a second implementation behind a nicer UI would repay for
 * both.
 *
 * ── UPSERT ONLY, AND IT NEVER OVERWRITES HUMAN WORK ─────────────────────────
 *
 * The CSV is the SCORER's output. status, status_note, notes, next_action_at,
 * last_touch_at, contact_name, contact_title, email, phone and linkedin_url
 * are the columns a person edits in the admin UI, and a re-import must not
 * flatten them — the whole point of the page is that a human can find a
 * contact the crawler could not. So a row that already exists has only its
 * SCORER-OWNED columns refreshed, and only where the file carries a value.
 *
 * Contact columns are filled ONLY when the existing row is empty: the crawler
 * may discover an address the database is missing, but it may never replace
 * one a human typed.
 *
 * There is no delete anywhere in this module. An account that drops out of
 * the file (rescored below a cut, filtered out of a queue) is not gone from
 * the world, and deleting it would take its status and notes with it.
 */
import {
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizePms,
  normalizeState,
  normalizeText,
  normalizeWebsite,
  parsePortfolio,
} from './normalize'
import type { ColumnIndex } from './columns'

/** Columns the scorer owns: refreshed on every import when the file has a value. */
export const SCORER_COLUMNS = [
  'website', 'comparent_url', 'city', 'state', 'market', 'region',
  'portfolio_size', 'portfolio_size_method', 'pms', 'pms_note',
  'score_a', 'score_b', 'track', 'bucket', 'gate', 'source',
] as const

/** Columns a person owns: only ever filled in, never overwritten. */
export const CONTACT_COLUMNS = [
  'contact_name', 'contact_title', 'email', 'phone', 'linkedin_url',
] as const

/**
 * The complete set of columns an import may write, and the allowlist the
 * server action validates every incoming patch against. `domain` is here
 * because claimDomain/guardPatchDomain may add it; `status`, `notes` and the
 * funnel columns are deliberately absent.
 */
export const WRITABLE_COLUMNS: readonly string[] = [
  'company', 'domain', ...SCORER_COLUMNS, ...CONTACT_COLUMNS,
]

export interface ProspectUpsert {
  company:               string
  domain:                string | null
  website:               string | null
  comparent_url:         string | null
  city:                  string | null
  state:                 string | null
  market:                string | null
  region:                string | null
  portfolio_size:        number | null
  portfolio_size_method: string | null
  pms:                   string | null
  pms_note:              string | null
  score_a:               number | null
  score_b:               number | null
  track:                 string | null
  bucket:                string | null
  gate:                  string | null
  contact_name:          string | null
  contact_title:         string | null
  email:                 string | null
  phone:                 string | null
  linkedin_url:          string | null
  source:                string | null
}

/**
 * The existing row a file row is resolved against.
 *
 * It carries the scorer columns as well as the identity and contact ones so
 * scorerPatch can skip a column whose value is already what the file says.
 * Without that, re-importing the master sheet reports ~3,400 updates — one
 * per row, nearly all of them writing city and state back over themselves —
 * and the update count is the number the operator reads to decide whether the
 * match key is working at all.
 */
export interface ExistingRow {
  id:                    string
  company:               string
  domain:                string | null
  city:                  string | null
  state:                 string | null
  market:                string | null
  region:                string | null
  website:               string | null
  comparent_url:         string | null
  portfolio_size:        number | null
  portfolio_size_method: string | null
  pms:                   string | null
  pms_note:              string | null
  score_a:               number | null
  score_b:               number | null
  track:                 string | null
  bucket:                string | null
  gate:                  string | null
  source:                string | null
  contact_name:          string | null
  contact_title:         string | null
  email:                 string | null
  phone:                 string | null
  linkedin_url:          string | null
}

/**
 * The columns loadExisting / the identity query must select.
 *
 * A single template literal, not a concatenation: postgrest-js infers the row
 * shape from the literal TYPE of the select string, and `'a' + 'b'` widens to
 * `string`, which collapses the result to GenericStringError[].
 */
export const EXISTING_COLUMNS = `
  id, company, domain, city, state, market, region, website, comparent_url,
  portfolio_size, portfolio_size_method, pms, pms_note, score_a, score_b,
  track, bucket, gate, source, contact_name, contact_title, email, phone,
  linkedin_url
`

export interface MappedRow {
  /** 1-based line in the source file, for an error the operator can find. */
  line:     number
  upsert:   ProspectUpsert | null
  warnings: string[]
}

// ── cell readers ─────────────────────────────────────────────────────────────

function text(row: readonly string[], at: number | undefined): string | null {
  if (at === undefined) return null
  const raw = row[at]?.trim()
  return raw === undefined || raw === '' || raw.toLowerCase() === 'nan' ? null : raw
}

function integer(row: readonly string[], at: number | undefined): number | null {
  const raw = text(row, at)
  if (raw === null) return null
  const n = Number(raw.replaceAll(',', ''))
  // A non-finite value is a header that moved or a stray word in a numeric
  // column. Null is honest; 0 would read as "we checked and it scored zero".
  return Number.isFinite(n) ? Math.round(n) : null
}

// ── one row ──────────────────────────────────────────────────────────────────

/** Everything the PMS cell and the ops-software cell contribute to pms_note. */
function pmsParts(
  row: readonly string[],
  ix: ColumnIndex,
): { pms: string | null; note: string | null } {
  const rawPms = text(row, ix.pms)
  const ops    = text(row, ix.ops_software)

  const { pms, evidence } = rawPms === null
    ? { pms: null, evidence: null }
    : normalizePms(rawPms)

  const noteParts = [
    text(row, ix.pms_note),
    evidence,
    ops === null ? null : `Ops: ${ops}`,
  ].filter((part): part is string => part !== null)

  return { pms, note: noteParts.length > 0 ? noteParts.join(' | ') : null }
}

/**
 * Maps one file row onto a prospect_accounts upsert.
 *
 * Warnings are returned rather than thrown: a cell this cannot use should
 * cost that cell, never the row and never the import. The wizard lists them
 * with their line numbers so the operator can fix the source.
 */
export function mapRow(row: readonly string[], ix: ColumnIndex, line: number): MappedRow {
  const warnings: string[] = []

  const company = text(row, ix.company)
  if (company === null) {
    return { line, upsert: null, warnings: ['No company name — row skipped'] }
  }

  const rawWebsite = text(row, ix.website)
  const website    = rawWebsite === null ? null : normalizeWebsite(rawWebsite)
  if (rawWebsite !== null && website === null) {
    warnings.push(`Website "${rawWebsite}" is not a usable http(s) address — left blank`)
  }

  const rawState = text(row, ix.state)
  // Falls back to the raw value rather than dropping it: an unrecognised
  // spelling is still the only location information the row has.
  const state = rawState === null ? null : (normalizeState(rawState) ?? rawState)

  const rawEmail = text(row, ix.email)
  const email    = rawEmail === null ? null : normalizeEmail(rawEmail)
  if (rawEmail !== null && email === null) {
    warnings.push(`Email "${rawEmail}" is not a valid address — left blank`)
  }

  const rawPhone = text(row, ix.phone)
  const phone    = rawPhone === null ? null : normalizePhone(rawPhone)

  const rawSize = text(row, ix.portfolio_size)
  const sourceUrl = text(row, ix.source_url)
  const { pms, note } = pmsParts(row, ix)

  return {
    line,
    warnings,
    upsert: {
      company,
      // A file may carry no domain column, only a website. Deriving it here is
      // what lets the unique index on lower(domain) do its job — and what lets
      // keysOf match on domain at all.
      domain:                normalizeDomain(text(row, ix.domain) ?? website),
      website,
      // prospect_accounts has exactly one URL column for provenance and the
      // crawler reads it, so only a real comparent.com link goes in. Other
      // source hosts are where a human found the row, not a profile the
      // crawler can parse.
      comparent_url:         text(row, ix.comparent_url)
                               ?? (sourceUrl?.includes('comparent.com') === true ? sourceUrl : null),
      city:                  text(row, ix.city),
      state,
      market:                text(row, ix.market),
      region:                text(row, ix.region),
      portfolio_size:        rawSize === null ? null : parsePortfolio(rawSize),
      // The raw cell, always — so "6 private cabins (Dall, Loon, Moose)"
      // survives next to the 6, and a prose-only cell is not thrown away.
      portfolio_size_method: text(row, ix.portfolio_size_method) ?? rawSize,
      pms,
      pms_note:              note,
      score_a:               integer(row, ix.score_a),
      score_b:               integer(row, ix.score_b),
      track:                 text(row, ix.track),
      bucket:                text(row, ix.bucket),
      gate:                  text(row, ix.gate),
      contact_name:          text(row, ix.contact_name),
      contact_title:         text(row, ix.contact_title),
      email,
      // The dialable form when there is one, the original text when there is
      // not: "call the office, ask for Dana" is still the only way to reach
      // some of these rows.
      phone:                 phone === null ? null : (phone.e164 ?? phone.raw),
      linkedin_url:          text(row, ix.linkedin_url),
      source:                text(row, ix.source),
    },
  }
}

/** Maps a whole parsed grid, header row excluded. */
export function mapRows(grid: readonly (readonly string[])[], ix: ColumnIndex): MappedRow[] {
  // +2: the grid excludes the header, and file lines are 1-based.
  return grid.map((row, at) => mapRow(row, ix, at + 2))
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * Identity keys for one row, strongest first.
 *
 * ── WHY THIS IS A LIST AND NOT A STRING ─────────────────────────────────────
 *
 * This was once `domain ?? name:<company>` — domain when there was one, name
 * otherwise, never both. That is a matcher that MISSES whenever the two sides
 * disagree about which identity they have, which is the normal case here:
 * 1,645 of the live rows were imported name-and-location only and carry no
 * domain at all, while the master sheet supplies a website for 1,801 rows.
 * DB keyed on `name:acme`, sheet keyed on `acme.com`, no match, second row
 * inserted.
 *
 * It is not hypothetical. 43 of the 51 duplicate company names already in the
 * table are exactly one row with a domain beside one without — this bug's own
 * fingerprint, from the last time the sheet was imported. The unique index on
 * lower(domain) cannot catch it either: the older row's domain is NULL, so
 * there is nothing for the new row to collide with.
 *
 * ── THE NAME KEY CARRIES CITY AND STATE, DELIBERATELY ───────────────────────
 *
 * Same company name in a different city, or a different state, is a DIFFERENT
 * company and must stay a separate row. The live table proves the point: Blue
 * Gems Mgmt in Orlando and in Vero Beach, Effortless Rental Group in Denver
 * and in Palm Springs, Elite Vacation Rentals in Chandler AZ and Orange Beach
 * AL — 21 of those 51 name collisions are genuinely distinct businesses. A
 * name-only key would merge them and silently destroy one of each pair.
 *
 * City is included even though the rule could be read as name+state alone,
 * because two operators in one state routinely share a name; and state is
 * included because city names repeat across states (Springfield, Columbus).
 */
export function keysOf(
  row: Readonly<{ company: string; domain: string | null; city: string | null; state: string | null }>,
): string[] {
  const keys: string[] = []
  // Normalized on BOTH sides. A file row's domain has been through
  // normalizeDomain by the time it gets here, but a stored one is whatever
  // was written — so keying the database side raw means "www.Acme.com" on
  // file and "acme.com" in the row never meet, and the match silently falls
  // through to the weaker name key.
  const domain = normalizeDomain(row.domain)
  if (domain !== null) keys.push(`domain:${domain}`)
  keys.push(`name:${normalizeName(row.company)}|${normalizeText(row.city)}|${normalizeText(row.state)}`)
  return keys
}

/** Copies every value `into` is missing from `from`, leaving what it has. */
function fillBlanks(into: ProspectUpsert, from: ProspectUpsert): void {
  for (const [field, value] of Object.entries(from) as [keyof ProspectUpsert, unknown][]) {
    if (into[field] === null && value !== null) Object.assign(into, { [field]: value })
  }
}

/**
 * Two file rows for one company is the dedupe bug this list already hit
 * (Suches Vacation Rentals appeared twice, once behind its parent brand).
 * Collapse on the SAME identity keys the database matcher uses — see keysOf —
 * keeping the first-seen row and filling its blanks from later duplicates
 * rather than discarding them.
 *
 * Using one key function for both halves is the point: a file deduped on a
 * looser rule than the database match would collapse two rows here and then
 * fail to find either of them there.
 */
export function dedupe(rows: readonly ProspectUpsert[]): { rows: ProspectUpsert[]; merged: number } {
  const byKey = new Map<string, ProspectUpsert>()
  let merged = 0

  for (const row of rows) {
    const keys = keysOf(row)
    const seenKey = keys.find((k) => byKey.has(k))
    if (seenKey === undefined) {
      for (const k of keys) byKey.set(k, row)
      continue
    }
    const seen = byKey.get(seenKey)
    if (seen === undefined) continue
    merged += 1
    fillBlanks(seen, row)
    // The merged row may have just GAINED a domain from its duplicate, so
    // register every key it now answers to.
    for (const k of keysOf(seen)) if (!byKey.has(k)) byKey.set(k, seen)
  }

  return { rows: [...new Set(byKey.values())], merged }
}

// ── plan ─────────────────────────────────────────────────────────────────────

export interface ImportPlan {
  updates:        { id: string; patch: Record<string, unknown> }[]
  inserts:        ProspectUpsert[]
  /** How many rows would write each column — the shape of the change. */
  fieldCounts:    Record<string, number>
  /** Rows written without their domain because another row already claims it. */
  droppedDomains: number
  /** Rows the file matched but had nothing new to add to. */
  untouched:      number
}

/** Existing rows indexed under EVERY key they answer to — see keysOf. */
function indexExisting(existing: readonly ExistingRow[]): Map<string, ExistingRow> {
  const byKey = new Map<string, ExistingRow>()
  for (const e of existing) {
    for (const k of keysOf(e)) if (!byKey.has(k)) byKey.set(k, e)
  }
  return byKey
}

/**
 * Scorer columns the file would actually change.
 *
 * A column whose incoming value equals what is already stored is left out:
 * writing it back is a no-op that still costs a row in the update count the
 * operator reads, and a round trip in the apply loop.
 */
function scorerPatch(row: ProspectUpsert, existing: ExistingRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const col of SCORER_COLUMNS) {
    const value = row[col]
    if (value !== null && value !== existing[col]) patch[col] = value
  }
  return patch
}

function contactBackfill(row: ProspectUpsert, existing: ExistingRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const col of CONTACT_COLUMNS) {
    if (existing[col] === null && row[col] !== null) patch[col] = row[col]
  }
  return patch
}

/**
 * A domain is FILLED, never replaced.
 *
 * It belongs in neither list above, and leaving it out of both was a real bug:
 * `domain` was absent from SCORER_COLUMNS and CONTACT_COLUMNS alike, so a
 * patch never carried one, guardPatchDomain below could never fire, and an
 * existing row could not gain a domain from an import no matter how many
 * times it ran. That is what keeps 1,645 live rows domain-less while the
 * master sheet supplies a website for 1,801 of them — and a domain-less row
 * is exactly the one keysOf has to fall back to a name match for.
 *
 * Fill-only rather than refresh-always because a stored domain may have been
 * corrected by a person, and unlike the other scorer columns this one is
 * uniquely indexed: replacing it can collide with another row.
 */
function domainPatch(row: ProspectUpsert, existing: ExistingRow): Record<string, unknown> {
  if (existing.domain !== null || row.domain === null) return {}
  return { domain: row.domain }
}

/** An insert keeps its domain only if no other row has claimed it. */
function claimDomain(row: ProspectUpsert, taken: Set<string>, plan: ImportPlan): ProspectUpsert {
  if (row.domain === null) return row
  if (taken.has(row.domain)) {
    // Same domain, different identity — a parent brand and its sub-brand, or
    // two file rows for one website. Keep the row, drop the claim.
    plan.droppedDomains += 1
    return { ...row, domain: null }
  }
  taken.add(row.domain)
  return row
}

/**
 * Never move a domain onto a row when another row already holds it.
 *
 * Defensive rather than routine: rows are deduped on the same domain key the
 * database match uses, so a file row naming a domain some row already holds
 * is normally matched to THAT row instead of reaching here. What it protects
 * against is the unique index on lower(domain) rejecting a whole chunk over
 * one row, which fails with nothing to say which row did it.
 */
function guardPatchDomain(
  patch: Record<string, unknown>,
  match: ExistingRow,
  taken: Set<string>,
  plan: ImportPlan,
): void {
  const next = patch.domain
  if (typeof next !== 'string') return
  if (taken.has(next) && match.domain !== next) {
    delete patch.domain
    plan.droppedDomains += 1
    return
  }
  taken.add(next)
}

/**
 * What the import WOULD do, computed before anything is written.
 *
 * Separated from the writing so the wizard's preview, the CLI's --plan and a
 * real run resolve every row through the identical code path: a plan computed
 * differently from the write it previews is worth nothing.
 */
export function buildPlan(
  rows: readonly ProspectUpsert[],
  existing: readonly ExistingRow[],
): ImportPlan {
  const byKey = indexExisting(existing)

  // lower(domain) is uniquely indexed, so a write carrying a domain some OTHER
  // row already holds fails its whole chunk with nothing to say which row did
  // it. Tracked so such a row can be written without its domain rather than
  // taking the good rows around it down too.
  const taken = new Set(
    existing.map((e) => normalizeDomain(e.domain)).filter((d): d is string => d !== null),
  )

  const plan: ImportPlan = {
    updates: [], inserts: [], fieldCounts: {}, droppedDomains: 0, untouched: 0,
  }

  for (const row of rows) {
    const match = keysOf(row).map((k) => byKey.get(k)).find((m) => m !== undefined)
    if (match === undefined) {
      plan.inserts.push(claimDomain(row, taken, plan))
      continue
    }

    const patch = { ...scorerPatch(row, match), ...contactBackfill(row, match), ...domainPatch(row, match) }
    guardPatchDomain(patch, match, taken, plan)
    if (Object.keys(patch).length === 0) {
      plan.untouched += 1
      continue
    }

    for (const col of Object.keys(patch)) plan.fieldCounts[col] = (plan.fieldCounts[col] ?? 0) + 1
    plan.updates.push({ id: match.id, patch })
  }

  for (const row of plan.inserts) {
    for (const [col, value] of Object.entries(row)) {
      if (value !== null) plan.fieldCounts[col] = (plan.fieldCounts[col] ?? 0) + 1
    }
  }

  return plan
}
