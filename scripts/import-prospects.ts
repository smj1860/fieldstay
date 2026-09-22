/**
 * Loads the offline prospecting CSV into prospect_accounts, which backs
 * /admin/prospects.
 *
 * Usage:
 *   pnpm exec tsx scripts/import-prospects.ts --file ./sheet.csv --dry-run
 *   pnpm exec tsx scripts/import-prospects.ts --file ./sheet.csv --plan
 *   pnpm exec tsx scripts/import-prospects.ts --file ./sheet.csv
 *
 * --dry-run touches no database and needs no credentials: it parses, maps and
 * dedupes, then prints what would be written. A malformed CSV fails there
 * rather than halfway through an upsert.
 *
 * --plan DOES read the database but writes nothing: it resolves every row
 * against the live table and reports how many would be updated, how many
 * inserted, and which columns would be filled. Run it before every real
 * import. An insert count anywhere near the file's row count means the match
 * key is missing rows it should be finding, and that is the failure worth
 * catching BEFORE it doubles the table.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPSERT ONLY, AND IT NEVER OVERWRITES HUMAN WORK.
 *
 * The CSV is the SCORER's output. status, status_note, notes, next_action_at,
 * last_touch_at, contact_name, contact_title, email, phone and linkedin_url
 * are the columns a person edits in the admin UI, and a re-import must not
 * flatten them — the whole point of the page is that Stephen can find a
 * contact the crawler could not. So a row that already exists has only its
 * SCORER-OWNED columns refreshed (scores, track, bucket, gate, portfolio_size,
 * pms, market, …), and only where the CSV actually carries a value.
 *
 * Contact columns are filled ONLY when the existing row is empty — the crawler
 * may discover an address the database is missing, but it may never replace one
 * a human typed.
 *
 * There is no delete anywhere in this file. An account that drops out of the
 * CSV (rescored below a cut, filtered out of a queue) is not gone from the
 * world, and deleting it would take its status and notes with it.
 */

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connect } from './prospecting/connect'
import {
  normalizeDomain,
  normalizeName,
  normalizePms,
  normalizeText,
} from '../lib/prospecting/normalize'

/** Columns the scorer owns: refreshed on every import when the CSV has a value. */
const SCORER_COLUMNS = [
  'website', 'comparent_url', 'city', 'state', 'market', 'region',
  'portfolio_size', 'portfolio_size_method', 'pms', 'pms_note',
  'score_a', 'score_b', 'track', 'bucket', 'gate', 'source',
] as const

/** Columns a person owns: only ever filled in, never overwritten. */
const CONTACT_COLUMNS = [
  'contact_name', 'contact_title', 'email', 'phone', 'linkedin_url',
] as const

interface ProspectUpsert {
  company:                string
  domain:                 string | null
  website:                string | null
  comparent_url:          string | null
  city:                   string | null
  state:                  string | null
  market:                 string | null
  region:                 string | null
  portfolio_size:         number | null
  portfolio_size_method:  string | null
  pms:                    string | null
  pms_note:               string | null
  score_a:                number | null
  score_b:                number | null
  track:                  string | null
  bucket:                 string | null
  gate:                   string | null
  contact_name:           string | null
  contact_title:          string | null
  email:                  string | null
  phone:                  string | null
  linkedin_url:           string | null
  source:                 string | null
}

// ── CSV ──────────────────────────────────────────────────────────────────────
// A real parser, not a split on commas: pms_note holds commas, quotes and
// newlines, and the master CSV has quoted multi-line Notes cells. Splitting on
// commas shifts every column after the first quoted one, which does not fail —
// it writes a phone number into the email column.

interface ScanState {
  rows:   string[][]
  row:    string[]
  cell:   string
  quoted: boolean
}

/** Inside quotes: only a doubled quote or a closing quote is special. */
function stepQuoted(st: ScanState, text: string, i: number): number {
  const ch = text[i]
  if (ch === '"' && text[i + 1] === '"') { st.cell += '"'; return i + 2 }
  if (ch === '"') { st.quoted = false; return i + 1 }
  st.cell += ch
  return i + 1
}

/** Outside quotes: a quote opens, a comma ends a cell, a newline ends a row. */
function stepBare(st: ScanState, text: string, i: number): number {
  const ch = text[i]
  if (ch === '"')  { st.quoted = true; return i + 1 }
  if (ch === ',')  { st.row.push(st.cell); st.cell = ''; return i + 1 }
  if (ch === '\r') { return i + 1 }
  if (ch === '\n') {
    st.row.push(st.cell)
    st.rows.push(st.row)
    st.row = []
    st.cell = ''
    return i + 1
  }
  st.cell += ch
  return i + 1
}

function parseCsv(text: string): string[][] {
  const st: ScanState = { rows: [], row: [], cell: '', quoted: false }
  let i = 0
  while (i < text.length) {
    i = st.quoted ? stepQuoted(st, text, i) : stepBare(st, text, i)
  }
  if (st.cell !== '' || st.row.length > 0) { st.row.push(st.cell); st.rows.push(st.row) }
  return st.rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * Header names differ between the queue CSVs and the master sheet
 * ("Owner / Decision Maker" vs contact_name, pms_f vs pms_n vs PMS). Each
 * target column lists its accepted source names in priority order, so one
 * importer reads every file the scorer produces.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  company:               ['company', 'Company'],
  domain:                ['domain', 'root_domain'],
  website:               ['website', 'Website'],
  comparent_url:         ['comparent_url'],
  city:                  ['city', 'City'],
  state:                 ['state', 'State'],
  market:                ['market', 'Market'],
  region:                ['region', 'Region'],
  portfolio_size:        ['ps', 'portfolio_size', 'Portfolio Size (est.)'],
  portfolio_size_method: ['portfolio_size_method', 'ps_src'],
  pms:                   ['pms_f', 'pms_n', 'pms', 'PMS'],
  // 'Notes' was an alias here and is now deliberately NOT. The master sheet's
  // Notes column is general prose about the company, and an earlier import
  // already packed it (plus confidence and source_url) into `notes` — every
  // one of the 3,399 live rows has it. Copying the same blob into pms_note,
  // whose stated job is HOW the PMS was determined, duplicates it under a
  // label that lies about what it is.
  pms_note:              ['pms_note'],
  // Which ops platform the prospect already runs (Breezeway et al). No column
  // of its own, and it is real competitive-displacement signal, so it is
  // folded into pms_note where PMS evidence already lives.
  ops_software:          ['Ops Software (Breezeway etc.)', 'ops_software'],
  // Where the row was found. On the master sheet this is a URL, and where it
  // points at comparent.com it IS the comparent_url the crawler needs.
  source_url:            ['Source', 'source_url'],
  score_a:               ['score_A', 'sA', 'score_a'],
  score_b:               ['score_B', 'sB', 'score_b'],
  track:                 ['track'],
  bucket:                ['bucket'],
  gate:                  ['gate'],
  contact_name:          ['Owner / Decision Maker', 'contact_name'],
  contact_title:         ['Title', 'contact_title'],
  email:                 ['Email', 'email'],
  phone:                 ['Phone', 'phone'],
  linkedin_url:          ['linkedin_url', 'LinkedIn'],
  source:                ['source'],
}

function buildIndex(header: string[]): Record<string, number> {
  const index: Record<string, number> = {}
  for (const [target, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const at = header.findIndex((h) => h.trim() === alias)
      if (at !== -1) { index[target] = at; break }
    }
  }
  return index
}

function text(row: string[], at: number | undefined): string | null {
  if (at === undefined) return null
  const raw = row[at]?.trim()
  return raw === undefined || raw === '' || raw.toLowerCase() === 'nan' ? null : raw
}

function integer(row: string[], at: number | undefined): number | null {
  const raw = text(row, at)
  if (raw === null) return null
  const n = Number(raw.replaceAll(',', ''))
  // A non-finite value is a header that moved or a stray word in a numeric
  // column. Null is honest; 0 would read as "we checked and it has no doors".
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * A leading integer, ignoring whatever prose follows it.
 *
 * The master sheet's size column is half numbers and half sentences — "80",
 * "6 private cabins (Dall, Loon, Moose)", "5 shown maybe more", "est. 150+",
 * "Part of national Neighborly network managing $16B+ in assets". Number()
 * returns NaN for every one of those, so the plain integer() reader would
 * discard 643 real counts to avoid 170 unparseable ones.
 *
 * Only a value that STARTS with digits is read. "est. 150+" stays null on
 * purpose: the number in it is real but its meaning ("at least") is not
 * something an integer column can carry, and the full text is preserved in
 * portfolio_size_method either way.
 */
function leadingInteger(raw: string | null): number | null {
  if (raw === null) return null
  const m = /^(\d[\d,]*)/.exec(raw.trim())
  if (m === null) return null
  const n = Number(m[1]!.replaceAll(',', ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

function toUpsert(row: string[], ix: Record<string, number>): ProspectUpsert | null {
  const company = text(row, ix.company)
  if (company === null) return null

  const website   = text(row, ix.website)
  const sourceUrl = text(row, ix.source_url)
  const rawSize   = text(row, ix.portfolio_size)
  const rawPms    = text(row, ix.pms)
  const ops       = text(row, ix.ops_software)

  // normalizePms splits the cell into the product and the evidence for it —
  // a crawler fingerprint ("Streamline (ownerx.streamlinevrs.com)"), a second
  // system the cell also named, or prose that was never a product at all.
  // The evidence, plus the ops platform, belong in pms_note. Joined rather
  // than one-or-other so neither is dropped when a row carries both.
  const { pms, evidence } = rawPms === null
    ? { pms: null, evidence: null }
    : normalizePms(rawPms)

  const noteParts = [
    text(row, ix.pms_note),
    evidence,
    ops === null ? null : `Ops: ${ops}`,
  ].filter((part): part is string => part !== null)

  return {
    company,
    // The master sheet has no domain column, only Website. Deriving it here is
    // what lets the unique index on lower(domain) do its job — and what lets
    // keyOf match on domain at all.
    domain:                normalizeDomain(text(row, ix.domain) ?? website),
    website,
    // prospect_accounts has exactly one URL column for provenance and the
    // crawler reads it, so only a real comparent.com link goes in. The sheet's
    // other Source hosts (keycrew.co, findrentals.com, bnbcalc.com …) are where
    // a human found the row, not a profile the crawler can parse.
    comparent_url:         sourceUrl !== null && sourceUrl.includes('comparent.com') ? sourceUrl : null,
    city:                  text(row, ix.city),
    state:                 text(row, ix.state),
    market:                text(row, ix.market),
    region:                text(row, ix.region),
    portfolio_size:        leadingInteger(rawSize),
    // The raw cell, always — so "6 private cabins (Dall, Loon, Moose)" survives
    // next to the 6, and a prose-only cell is not simply thrown away.
    portfolio_size_method: text(row, ix.portfolio_size_method) ?? rawSize,
    pms,
    pms_note:              noteParts.length > 0 ? noteParts.join(' | ') : null,
    score_a:               integer(row, ix.score_a),
    score_b:               integer(row, ix.score_b),
    track:                 text(row, ix.track),
    bucket:                text(row, ix.bucket),
    gate:                  text(row, ix.gate),
    contact_name:          text(row, ix.contact_name),
    contact_title:         text(row, ix.contact_title),
    email:                 text(row, ix.email)?.toLowerCase() ?? null,
    phone:                 text(row, ix.phone),
    linkedin_url:          text(row, ix.linkedin_url),
    source:                text(row, ix.source),
  }
}

/**
 * Two CSV rows for one company is the dedupe bug this list already hit
 * (Suches Vacation Rentals appeared twice, once behind its parent brand).
 * Collapse on the SAME identity keys the database matcher uses — see keysOf —
 * keeping the first-seen row and filling its blanks from later duplicates
 * rather than discarding them.
 *
 * Using one key function for both halves is the point: a file deduped on a
 * looser rule than the database match would collapse two rows here and then
 * fail to find either of them there.
 */
/** Copies every value `into` is missing from `from`, leaving what it has. */
function fillBlanks(into: ProspectUpsert, from: ProspectUpsert): void {
  for (const [field, value] of Object.entries(from) as [keyof ProspectUpsert, unknown][]) {
    if (into[field] === null && value !== null) Object.assign(into, { [field]: value })
  }
}

function dedupe(rows: ProspectUpsert[]): { rows: ProspectUpsert[]; merged: number } {
  const byKey = new Map<string, ProspectUpsert>()
  let merged = 0

  for (const row of rows) {
    const keys = keysOf(row)
    const seenKey = keys.find((k) => byKey.has(k))
    if (seenKey === undefined) {
      for (const k of keys) byKey.set(k, row)
      continue
    }
    const seen = byKey.get(seenKey)!
    merged += 1
    fillBlanks(seen, row)
    // The merged row may have just GAINED a domain from its duplicate, so
    // register every key it now answers to.
    for (const k of keysOf(seen)) if (!byKey.has(k)) byKey.set(k, seen)
  }

  return { rows: [...new Set(byKey.values())], merged }
}

// ── write ────────────────────────────────────────────────────────────────────

interface ExistingRow {
  id:      string
  company: string
  domain:  string | null
  city:    string | null
  state:   string | null
  contact_name:  string | null
  contact_title: string | null
  email:         string | null
  phone:         string | null
  linkedin_url:  string | null
}

/** Fetches every existing row; the table is thousands of rows, not millions. */
async function loadExisting(supabase: SupabaseClient): Promise<ExistingRow[]> {
  const all: ExistingRow[] = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('prospect_accounts')
      .select('id, company, domain, city, state, contact_name, contact_title, email, phone, linkedin_url')
      .order('id')
      .range(from, from + page - 1)
    if (error) throw new Error(`loadExisting: ${error.message}`)
    const batch = (data ?? []) as ExistingRow[]
    all.push(...batch)
    if (batch.length < page) return all
  }
}

/**
 * Identity keys for one row, strongest first.
 *
 * ── WHY THIS IS A LIST AND NOT A STRING ─────────────────────────────────────
 *
 * This used to be `domain ?? name:<company>` — domain when there was one, name
 * otherwise, never both. That is a matcher that MISSES whenever the two sides
 * disagree about which identity they have, which is the normal case here: 1,645
 * of the live rows were imported name-and-location only and carry no domain at
 * all, while the master sheet supplies a website for 1,801 rows. DB keyed on
 * `name:acme`, sheet keyed on `acme.com`, no match, second row inserted.
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
 * Gems Mgmt in Orlando and in Vero Beach, Effortless Rental Group in Denver and
 * in Palm Springs, Elite Vacation Rentals in Chandler AZ and Orange Beach AL —
 * 21 of those 51 name collisions are genuinely distinct businesses. A name-only
 * key would merge them and silently destroy one of each pair.
 *
 * City is included even though the rule could be read as name+state alone,
 * because two operators in one state routinely share a name; and state is
 * included because city names repeat across states (Springfield, Columbus).
 */
function keysOf(row: { company: string; domain: string | null; city: string | null; state: string | null }): string[] {
  const keys: string[] = []
  if (row.domain !== null) keys.push(`domain:${row.domain}`)
  keys.push(`name:${normalizeName(row.company)}|${normalizeText(row.city)}|${normalizeText(row.state)}`)
  return keys
}

function scorerPatch(row: ProspectUpsert): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const col of SCORER_COLUMNS) {
    const value = row[col]
    if (value !== null) patch[col] = value
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

/** Reads the CSV named on the command line into deduped upsert rows. */
function loadRows(file: string): ProspectUpsert[] {
  const grid = parseCsv(readFileSync(file, 'utf8'))
  if (grid.length < 2) { console.error('CSV has no data rows.'); process.exit(1) }

  const ix = buildIndex(grid[0])
  if (ix.company === undefined) {
    console.error('No "company"/"Company" column found. Headers:', grid[0].slice(0, 12).join(' | '))
    process.exit(1)
  }

  const parsed = grid.slice(1)
    .map((r) => toUpsert(r, ix))
    .filter((r): r is ProspectUpsert => r !== null)
  const { rows, merged } = dedupe(parsed)

  console.log(`parsed ${parsed.length} rows → ${rows.length} unique (${merged} merged)`)
  console.log(`mapped columns: ${Object.keys(ix).join(', ')}`)
  return rows
}

function printPreview(rows: ProspectUpsert[]): void {
  console.table(rows.slice(0, 10).map((r) => ({
    company: r.company, domain: r.domain, state: r.state,
    pms: r.pms, doors: r.portfolio_size, email: r.email,
  })))
  console.log('--dry-run: nothing written.')
}

/**
 * What the import WOULD do, computed before anything is written.
 *
 * Separated from the writing so --plan and a real run resolve every row
 * through the identical code path: a plan that is computed differently from
 * the write it previews is worth nothing.
 */
interface ImportPlan {
  updates:        Array<{ id: string; patch: Record<string, unknown> }>
  inserts:        ProspectUpsert[]
  fieldCounts:    Record<string, number>
  droppedDomains: number
}

/** Existing rows indexed under EVERY key they answer to — see keysOf. */
function indexExisting(existing: ExistingRow[]): Map<string, ExistingRow> {
  const byKey = new Map<string, ExistingRow>()
  for (const e of existing) {
    for (const k of keysOf(e)) if (!byKey.has(k)) byKey.set(k, e)
  }
  return byKey
}

function buildPlan(rows: ProspectUpsert[], existing: ExistingRow[]): ImportPlan {
  const byKey = indexExisting(existing)

  // lower(domain) is uniquely indexed, so a write carrying a domain some OTHER
  // row already holds fails its whole 250-row chunk with nothing to say which
  // row did it. Tracked so such a row can be written without its domain rather
  // than taking 249 good rows down with it.
  const taken = new Set(existing.map((e) => normalizeDomain(e.domain)).filter((d): d is string => d !== null))

  const plan: ImportPlan = { updates: [], inserts: [], fieldCounts: {}, droppedDomains: 0 }

  for (const row of rows) {
    const match = keysOf(row).map((k) => byKey.get(k)).find((m) => m !== undefined)
    if (match === undefined) {
      plan.inserts.push(claimDomain(row, taken, plan))
      continue
    }

    const patch = { ...scorerPatch(row), ...contactBackfill(row, match) }
    guardPatchDomain(patch, match, taken, plan)
    if (Object.keys(patch).length === 0) continue

    for (const col of Object.keys(patch)) plan.fieldCounts[col] = (plan.fieldCounts[col] ?? 0) + 1
    plan.updates.push({ id: match.id, patch })
  }

  return plan
}

/** An insert keeps its domain only if no other row has claimed it. */
function claimDomain(row: ProspectUpsert, taken: Set<string>, plan: ImportPlan): ProspectUpsert {
  if (row.domain === null) return row
  if (taken.has(row.domain)) {
    // Same domain, different identity — a parent brand and its sub-brand, or
    // two sheet rows for one website. Keep the row, drop the claim.
    plan.droppedDomains += 1
    return { ...row, domain: null }
  }
  taken.add(row.domain)
  return row
}

/** Never move a domain onto a row when another row already holds it. */
function guardPatchDomain(
  patch: Record<string, unknown>,
  match: ExistingRow,
  taken: Set<string>,
  plan:  ImportPlan,
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

function printPlan(plan: ImportPlan, total: number): void {
  const untouched = total - plan.inserts.length - plan.updates.length
  console.log('')
  console.log('--plan: NOTHING WRITTEN.')
  console.log(`  would UPDATE ${plan.updates.length} existing row(s)`)
  console.log(`  would INSERT ${plan.inserts.length} new row(s)`)
  console.log(`  would leave  ${untouched} row(s) untouched (nothing new to add)`)
  if (plan.droppedDomains > 0) {
    console.log(`  ${plan.droppedDomains} row(s) would be written without a domain (another row claims it)`)
  }
  console.log('')
  console.log('  columns that would be written, by row count:')
  for (const [col, n] of Object.entries(plan.fieldCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${col.padEnd(24)} ${n}`)
  }
  console.log('')
  console.log('  An INSERT count anywhere near the file row count means the match key is')
  console.log('  NOT finding rows it should. Stop and look before running without --plan.')
}

async function applyPlan(supabase: SupabaseClient, plan: ImportPlan): Promise<void> {
  for (const { id, patch } of plan.updates) {
    const { error } = await supabase.from('prospect_accounts').update(patch).eq('id', id)
    if (error) throw new Error(`update ${id}: ${error.message}`)
  }

  // Chunked: one 2,600-row insert is a single statement Postgres holds in
  // memory, and one bad row fails the whole thing with no indication which.
  const CHUNK = 250
  for (let at = 0; at < plan.inserts.length; at += CHUNK) {
    const chunk = plan.inserts.slice(at, at + CHUNK)
    const { error } = await supabase.from('prospect_accounts').insert(chunk)
    if (error) throw new Error(`insert chunk at ${at}: ${error.message}`)
  }
}

async function main(): Promise<void> {
  const args   = process.argv.slice(2)
  const fileAt = args.indexOf('--file')
  const file   = args[fileAt + 1]
  if (fileAt === -1 || file === undefined) {
    console.error('Usage: tsx scripts/import-prospects.ts --file <path.csv> [--dry-run|--plan]')
    process.exit(1)
  }

  const rows = loadRows(file)
  if (args.includes('--dry-run')) { printPreview(rows); return }

  const supabase = connect()
  const plan     = buildPlan(rows, await loadExisting(supabase))

  if (args.includes('--plan')) { printPlan(plan, rows.length); return }

  await applyPlan(supabase, plan)

  const untouched = rows.length - plan.inserts.length - plan.updates.length
  console.log(`inserted ${plan.inserts.length}, updated ${plan.updates.length}, untouched ${untouched}`)
  if (plan.droppedDomains > 0) {
    console.log(`  (${plan.droppedDomains} row(s) written without a domain — another row already claims it)`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
