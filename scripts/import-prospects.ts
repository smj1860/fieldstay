/**
 * Loads a prospecting CSV into prospect_accounts, which backs /admin/prospects.
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
 * ── THIS FILE IS THE CLI, NOT THE IMPORTER ──────────────────────────────────
 *
 * Parsing, column mapping, normalization, identity matching and the merge
 * policy all live in lib/prospecting/*, which /admin/prospects/import runs in
 * the browser. Both paths resolve rows through the same buildPlan(), so the
 * wizard cannot drift into a looser dedupe rule than this script's — the
 * failure that put 51 duplicate company names in the live table.
 *
 * Everything this file adds is the parts a browser cannot do: reading a file
 * off disk, holding the service role key, and printing.
 */
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connect } from './prospecting/connect'
import { parseCsv } from '../lib/prospecting/csv'
import { autoMapColumns } from '../lib/prospecting/columns'
import {
  buildPlan,
  dedupe,
  mapRows,
  EXISTING_COLUMNS,
  type ExistingRow,
  type ImportPlan,
  type ProspectUpsert,
} from '../lib/prospecting/import'

const PAGE = 1000
const CHUNK = 250

/** Fetches every existing row; the table is thousands of rows, not millions. */
async function loadExisting(supabase: SupabaseClient): Promise<ExistingRow[]> {
  const all: ExistingRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('prospect_accounts')
      .select(EXISTING_COLUMNS)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`loadExisting: ${error.message}`)
    // EXISTING_COLUMNS is a runtime string, so postgrest cannot infer the
    // row shape from it; the module that defines the list owns the type.
    const batch = (data ?? []) as unknown as ExistingRow[]
    all.push(...batch)
    if (batch.length < PAGE) return all
  }
}

/** Reads the CSV named on the command line into deduped upsert rows. */
function loadRows(file: string): ProspectUpsert[] {
  const grid = parseCsv(readFileSync(file, 'utf8'))
  if (grid.length < 2) { console.error('CSV has no data rows.'); process.exit(1) }

  const header = grid[0]
  const ix = autoMapColumns(header)
  if (ix.company === undefined) {
    console.error('No "company"/"Company" column found. Headers:', header.slice(0, 12).join(' | '))
    process.exit(1)
  }

  const mapped = mapRows(grid.slice(1), ix)
  const parsed = mapped
    .map((m) => m.upsert)
    .filter((r): r is ProspectUpsert => r !== null)
  const { rows, merged } = dedupe(parsed)

  const warnings = mapped.flatMap((m) => m.warnings.map((w) => `  line ${m.line}: ${w}`))

  console.log(`parsed ${parsed.length} rows → ${rows.length} unique (${merged} merged)`)
  console.log(`mapped columns: ${Object.keys(ix).join(', ')}`)
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`)
    for (const w of warnings.slice(0, 40)) console.log(w)
    if (warnings.length > 40) console.log(`  … and ${warnings.length - 40} more`)
  }
  return rows
}

function printPreview(rows: ProspectUpsert[]): void {
  console.table(rows.slice(0, 10).map((r) => ({
    company: r.company, domain: r.domain, state: r.state,
    pms: r.pms, doors: r.portfolio_size, email: r.email,
  })))
  console.log('--dry-run: nothing written.')
}

function printPlan(plan: ImportPlan, total: number): void {
  console.log('')
  console.log('--plan: NOTHING WRITTEN.')
  console.log(`  would UPDATE ${plan.updates.length} existing row(s)`)
  console.log(`  would INSERT ${plan.inserts.length} new row(s)`)
  console.log(`  would leave  ${plan.untouched} row(s) untouched (nothing new to add)`)
  if (plan.droppedDomains > 0) {
    console.log(`  ${plan.droppedDomains} row(s) would be written without a domain (another row claims it)`)
  }
  console.log('')
  console.log('  columns that would be written, by row count:')
  for (const [col, n] of Object.entries(plan.fieldCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${col.padEnd(24)} ${n}`)
  }
  console.log('')
  console.log(`  (${total} row(s) in the file after dedupe)`)
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

  console.log(`inserted ${plan.inserts.length}, updated ${plan.updates.length}, untouched ${plan.untouched}`)
  if (plan.droppedDomains > 0) {
    console.log(`  (${plan.droppedDomains} row(s) written without a domain — another row already claims it)`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
