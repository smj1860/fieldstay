/**
 * Feeding the strscout scraper's list into the /admin/prospects funnel.
 *
 * `str_prospects` is written by the scraper (service role, deny-all RLS) and
 * `prospect_accounts` is the funnel a person works. Nothing connected them, so
 * a company the scraper found was invisible to the page built for calling it.
 *
 * ── THIS SOURCE ONLY EVER FILLS BLANKS ──────────────────────────────────────
 *
 * lib/prospecting/import.ts refreshes its SCORER_COLUMNS on every run, because
 * its input IS the scorer's output and a re-score is meant to win. strscout is
 * a directory/registry scrape — lower confidence than both the scorer CSV and
 * the comparent crawl — so it gets the weaker contract: on an account that
 * already exists it may fill a column that is empty and may never overwrite
 * one that is not. Measured against the live data this costs almost nothing
 * (of 67 accounts it matches, it would fill 12 phones and nothing else) while
 * removing any chance of a directory listing overwriting a door count the
 * crawler derived or a PMS someone confirmed.
 *
 * Identity matching and file-level dedupe are IMPORTED from import.ts rather
 * than rewritten: a second matcher with a looser rule is how a list grows a
 * second copy of every company, which this one already did once.
 */
import {
  buildPlan,
  dedupe,
  keysOf,
  type ExistingRow,
  type ImportPlan,
  type ProspectUpsert,
} from './import'
import {
  cleanText,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  normalizePms,
  normalizeState,
  normalizeWebsite,
} from './normalize'

/** What `source` is stamped on an account this sync creates. */
export const STRSCOUT_SOURCE = 'strscout'

/**
 * The columns the sync reads off str_prospects.
 *
 * A single template literal, not a concatenation: postgrest-js infers the row
 * shape from the literal TYPE of the select string.
 */
export const STR_PROSPECT_COLUMNS = `
  dedupe_key, name, kind, state, city, website, domain, phone, email,
  property_count, source, last_seen, pms
`

export interface StrProspectRow {
  dedupe_key:     string
  name:           string
  kind:           string | null
  state:          string | null
  city:           string | null
  website:        string | null
  domain:         string | null
  phone:          string | null
  email:          string | null
  property_count: number | null
  source:         string | null
  last_seen:      string | null
  pms:            string | null
}

/**
 * Maps one scraper row onto the funnel's shape.
 *
 * Every field goes through cleanText, which turns '' into null. That is not
 * cosmetic here: the scraper writes EMPTY STRINGS rather than NULLs (247 of
 * its 252 ICP rows have `email = ''`), and an empty string written into
 * prospect_accounts.email would count as "already has an email" forever —
 * blocking the fill-only backfill above from ever putting a real one there,
 * and feeding the GENERATED email_is_generic column a value that describes
 * nothing.
 */
export function toProspectUpsert(row: StrProspectRow): ProspectUpsert | null {
  const company = cleanText(row.name ?? '')
  if (company === '') return null

  const website = normalizeWebsite(cleanText(row.website ?? ''))
  const rawState = cleanText(row.state ?? '')
  const rawPms = cleanText(row.pms ?? '')
  const { pms, evidence } = rawPms === '' ? { pms: null, evidence: null } : normalizePms(rawPms)

  const phone = normalizePhone(cleanText(row.phone ?? ''))
  const email = normalizeEmail(cleanText(row.email ?? ''))

  // property_count is 0 for the scraper's "unsized" directory rows. Null is
  // honest there; 0 would read as "we checked and it has no doors".
  const doors = row.property_count !== null && row.property_count > 0 ? row.property_count : null

  return {
    company,
    domain:                normalizeDomain(cleanText(row.domain ?? '') || website),
    website,
    comparent_url:         null,
    city:                  cleanText(row.city ?? '') || null,
    // Falls back to the raw value rather than dropping the only location the
    // row has, same rule the CSV importer applies.
    state:                 rawState === '' ? null : (normalizeState(rawState) ?? rawState),
    market:                null,
    region:                null,
    portfolio_size:        doors,
    portfolio_size_method: doors === null ? null : `strscout:${cleanText(row.source ?? '') || 'directory'}`,
    pms,
    pms_note:              evidence,
    // The offline scorer owns these; a scrape has no opinion on them.
    score_a:               null,
    score_b:               null,
    track:                 null,
    bucket:                null,
    gate:                  null,
    contact_name:          null,
    contact_title:         null,
    email,
    phone:                 phone.e164 ?? phone.raw,
    linkedin_url:          null,
    // Stamped on inserts only — see planStrProspectSync.
    source:                null,
  }
}

/** Columns this sync is allowed to fill on an account that already exists. */
const FILLABLE = [
  'domain', 'website', 'city', 'state', 'portfolio_size',
  'portfolio_size_method', 'pms', 'pms_note', 'email', 'phone',
] as const satisfies readonly (keyof ProspectUpsert)[]

/** Existing rows under every identity key they answer to — see keysOf. */
function indexByIdentity(existing: readonly ExistingRow[]): Map<string, ExistingRow> {
  const byKey = new Map<string, ExistingRow>()
  for (const e of existing) {
    for (const k of keysOf(e)) if (!byKey.has(k)) byKey.set(k, e)
  }
  return byKey
}

/**
 * Columns that describe another column and must never be written without it.
 *
 * portfolio_size_method says where a door count came from and pms_note says
 * how a PMS was identified. Filling either on its own attaches this scrape's
 * provenance to a value some OTHER source supplied — an account whose count of
 * 40 came from the comparent crawl would start claiming "strscout:directory".
 * Caught by a test; the fill-only rule alone does not prevent it, because the
 * describing column is legitimately empty on exactly the rows where the
 * described one is already full.
 */
const DESCRIBES: ReadonlyArray<readonly [describing: string, described: string]> = [
  ['portfolio_size_method', 'portfolio_size'],
  ['pms_note',              'pms'],
]

/** Columns the account is missing that this row can supply, and nothing else. */
function fillOnlyPatch(row: ProspectUpsert, match: ExistingRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const col of FILLABLE) {
    if (match[col] === null && row[col] !== null) patch[col] = row[col]
  }
  for (const [describing, described] of DESCRIBES) {
    if (describing in patch && !(described in patch)) delete patch[describing]
  }
  return patch
}

function countFields(counts: Record<string, number>, columns: Iterable<string>): void {
  for (const col of columns) counts[col] = (counts[col] ?? 0) + 1
}

/**
 * What the sync WOULD do, in the same shape buildPlan returns.
 *
 * Inserts come straight from buildPlan — its domain-collision guard and its
 * dedupe are exactly what is wanted for new rows. Updates are recomputed
 * fill-only, because buildPlan's scorer contract is the wrong one for this
 * source (see the module header).
 */
export function planStrProspectSync(
  rows: readonly ProspectUpsert[],
  existing: readonly ExistingRow[],
): ImportPlan {
  const deduped = dedupe(rows).rows
  const base = buildPlan(deduped, existing)
  const byKey = indexByIdentity(existing)

  const plan: ImportPlan = {
    inserts:        base.inserts.map((r) => ({ ...r, source: STRSCOUT_SOURCE })),
    updates:        [],
    fieldCounts:    {},
    droppedDomains: base.droppedDomains,
    untouched:      0,
  }

  for (const row of deduped) {
    const match = keysOf(row).map((k) => byKey.get(k)).find((m) => m !== undefined)
    if (match === undefined) continue

    const patch = fillOnlyPatch(row, match)
    if (Object.keys(patch).length === 0) {
      plan.untouched += 1
      continue
    }
    countFields(plan.fieldCounts, Object.keys(patch))
    plan.updates.push({ id: match.id, patch })
  }

  for (const row of plan.inserts) {
    countFields(
      plan.fieldCounts,
      Object.entries(row).filter(([, v]) => v !== null).map(([col]) => col),
    )
  }

  return plan
}
