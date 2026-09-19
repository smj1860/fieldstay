/**
 * Loads the offline prospecting CSV into prospect_accounts, which backs
 * /admin/prospects.
 *
 * Usage:
 *   pnpm exec tsx scripts/import-prospects.ts --file ./scored-final.csv --dry-run
 *   pnpm exec tsx scripts/import-prospects.ts --file ./scored-final.csv
 *
 * --dry-run touches no database and needs no credentials: it parses, maps and
 * dedupes, then prints what would be written. A malformed CSV fails there
 * rather than halfway through an upsert.
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
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const KNOWN_PROJECTS = ['vpmznjktllhmmbfnxuvk', 'syhthijeqlnltufdawyb']

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
  pms_note:              ['pms_note', 'Notes'],
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
  source:                ['Source', 'source'],
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

/** Strips scheme, www and any path so the unique index sees one spelling. */
function normalizeDomain(raw: string | null): string | null {
  if (raw === null) return null
  const d = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim()
    .toLowerCase()
  return d === '' ? null : d
}

function toUpsert(row: string[], ix: Record<string, number>): ProspectUpsert | null {
  const company = text(row, ix.company)
  if (company === null) return null

  return {
    company,
    domain:                normalizeDomain(text(row, ix.domain)),
    website:               text(row, ix.website),
    comparent_url:         text(row, ix.comparent_url),
    city:                  text(row, ix.city),
    state:                 text(row, ix.state),
    market:                text(row, ix.market),
    region:                text(row, ix.region),
    portfolio_size:        integer(row, ix.portfolio_size),
    portfolio_size_method: text(row, ix.portfolio_size_method),
    pms:                   text(row, ix.pms),
    pms_note:              text(row, ix.pms_note),
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
 * Collapse on domain where there is one and on lowercased company name where
 * there is not, keeping the first-seen row and filling its blanks from later
 * duplicates rather than discarding them.
 */
function dedupe(rows: ProspectUpsert[]): { rows: ProspectUpsert[]; merged: number } {
  const byKey = new Map<string, ProspectUpsert>()
  let merged = 0

  for (const row of rows) {
    const key = row.domain ?? `name:${row.company.toLowerCase()}`
    const seen = byKey.get(key)
    if (seen === undefined) { byKey.set(key, row); continue }
    merged += 1
    for (const [field, value] of Object.entries(row) as [keyof ProspectUpsert, unknown][]) {
      if (seen[field] === null && value !== null) {
        Object.assign(seen, { [field]: value })
      }
    }
  }

  return { rows: [...byKey.values()], merged }
}

// ── write ────────────────────────────────────────────────────────────────────

interface ExistingRow {
  id:      string
  company: string
  domain:  string | null
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
      .select('id, company, domain, contact_name, contact_title, email, phone, linkedin_url')
      .order('id')
      .range(from, from + page - 1)
    if (error) throw new Error(`loadExisting: ${error.message}`)
    const batch = (data ?? []) as ExistingRow[]
    all.push(...batch)
    if (batch.length < page) return all
  }
}

function keyOf(company: string, domain: string | null): string {
  return domain ?? `name:${company.toLowerCase()}`
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

/**
 * Refuses a URL that does not name a FieldStay project, so a stray .env never
 * points this at someone else's database.
 */
function connect(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || key === undefined) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exit(1)
  }
  if (!KNOWN_PROJECTS.some((project) => url.includes(project))) {
    console.error(`Refusing to run: ${url} does not name a known FieldStay project.`)
    process.exit(1)
  }
  return createClient(url, key)
}

function printPreview(rows: ProspectUpsert[]): void {
  console.table(rows.slice(0, 10).map((r) => ({
    company: r.company, domain: r.domain, state: r.state,
    pms: r.pms, doors: r.portfolio_size, email: r.email,
  })))
  console.log('--dry-run: nothing written.')
}

async function main(): Promise<void> {
  const args   = process.argv.slice(2)
  const fileAt = args.indexOf('--file')
  const file   = args[fileAt + 1]
  if (fileAt === -1 || file === undefined) {
    console.error('Usage: tsx scripts/import-prospects.ts --file <path.csv> [--dry-run]')
    process.exit(1)
  }

  const rows = loadRows(file)
  if (args.includes('--dry-run')) { printPreview(rows); return }

  const supabase = connect()
  const existing = await loadExisting(supabase)
  const byKey = new Map(existing.map((e) => [keyOf(e.company, e.domain), e]))

  const inserts: ProspectUpsert[] = []
  let updated = 0

  for (const row of rows) {
    const match = byKey.get(keyOf(row.company, row.domain))
    if (match === undefined) { inserts.push(row); continue }

    const patch = { ...scorerPatch(row), ...contactBackfill(row, match) }
    if (Object.keys(patch).length === 0) continue

    const { error } = await supabase.from('prospect_accounts').update(patch).eq('id', match.id)
    if (error) throw new Error(`update ${row.company}: ${error.message}`)
    updated += 1
  }

  // Chunked: one 2,600-row insert is a single statement Postgres holds in
  // memory, and one bad row fails the whole thing with no indication which.
  const CHUNK = 250
  for (let at = 0; at < inserts.length; at += CHUNK) {
    const chunk = inserts.slice(at, at + CHUNK)
    const { error } = await supabase.from('prospect_accounts').insert(chunk)
    if (error) throw new Error(`insert chunk at ${at}: ${error.message}`)
  }

  console.log(`inserted ${inserts.length}, updated ${updated}, untouched ${rows.length - inserts.length - updated}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
