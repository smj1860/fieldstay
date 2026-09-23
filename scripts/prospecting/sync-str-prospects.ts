/**
 * Feeds the strscout scraper's list (str_prospects) into the /admin/prospects
 * funnel (prospect_accounts).
 *
 * Usage:
 *   pnpm exec tsx scripts/prospecting/sync-str-prospects.ts --plan
 *   pnpm exec tsx scripts/prospecting/sync-str-prospects.ts
 *   pnpm exec tsx scripts/prospecting/sync-str-prospects.ts --sized-only
 *
 * --plan reads both tables and writes nothing: it prints how many accounts
 * would be added, how many would be filled in, and which columns. Run it
 * first. There is no --dry-run because there is no file to parse; the live
 * table IS the input.
 *
 * --sized-only skips the scraper's "unsized" rows (property_count = 0). About
 * 99 of the 175 companies it would currently add have no door count, and a
 * funnel sorted on score has nowhere sensible to put them; skip them if you
 * would rather work the sized ones first.
 *
 * ── WHICH ROWS ──────────────────────────────────────────────────────────────
 *
 * Membership comes from public.str_prospects_icp, the view that already
 * defines the FieldStay ICP (10-150 core, gray band to 225, plus unsized
 * directory rows). The view is read for its dedupe_keys and the base table for
 * the columns — the view does not expose `domain`, and duplicating its WHERE
 * clause here would be a second copy of the ICP rule to drift.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It only ever FILLS on an account that already exists; see the contract in
 * lib/prospecting/str-prospects.ts. It never deletes, never moves a funnel
 * stage, and never touches status, notes, next_action_at or a contact name.
 */
import { connect } from './connect'
import {
  EXISTING_COLUMNS,
  type ExistingRow,
  type ImportPlan,
  type ProspectUpsert,
} from '../../lib/prospecting/import'
import {
  STR_PROSPECT_COLUMNS,
  planStrProspectSync,
  toProspectUpsert,
  type StrProspectRow,
} from '../../lib/prospecting/str-prospects'

const PAGE = 1000
const CHUNK = 250

type Supabase = ReturnType<typeof connect>

/** Every page of a table; these are thousands of rows, not millions. */
async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = (data ?? []) as T[]
    all.push(...batch)
    if (batch.length < PAGE) return all
  }
}

async function loadIcpRows(supabase: Supabase, sizedOnly: boolean): Promise<StrProspectRow[]> {
  // The view owns the ICP definition; read it for membership only.
  const icp = await fetchAll<{ dedupe_key: string }>(
    (from, to) => supabase.from('str_prospects_icp').select('dedupe_key').order('dedupe_key').range(from, to),
    'str_prospects_icp',
  )
  const keys = icp.map((r) => r.dedupe_key)
  if (keys.length === 0) return []

  const rows: StrProspectRow[] = []
  for (let at = 0; at < keys.length; at += CHUNK) {
    const slice = keys.slice(at, at + CHUNK)
    const { data, error } = await supabase
      .from('str_prospects')
      .select(STR_PROSPECT_COLUMNS)
      .in('dedupe_key', slice)
    if (error) throw new Error(`str_prospects: ${error.message}`)
    rows.push(...((data ?? []) as unknown as StrProspectRow[]))
  }

  return sizedOnly ? rows.filter((r) => (r.property_count ?? 0) > 0) : rows
}

function loadExisting(supabase: Supabase): Promise<ExistingRow[]> {
  return fetchAll<ExistingRow>(
    (from, to) => supabase.from('prospect_accounts').select(EXISTING_COLUMNS).order('id').range(from, to),
    'prospect_accounts',
  )
}

function printPlan(plan: ImportPlan, considered: number): void {
  console.log('')
  console.log(`  considered ${considered} ICP row(s) from the scraper`)
  console.log(`  would ADD  ${plan.inserts.length} account(s) to the funnel`)
  console.log(`  would FILL ${plan.updates.length} existing account(s)`)
  console.log(`  would leave ${plan.untouched} matched account(s) untouched`)
  if (plan.droppedDomains > 0) {
    console.log(`  ${plan.droppedDomains} row(s) written without a domain (another account claims it)`)
  }
  console.log('')
  console.log('  columns that would be written, by row count:')
  for (const [col, n] of Object.entries(plan.fieldCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${col.padEnd(24)} ${n}`)
  }
  console.log('')
  console.log('  Existing accounts are only ever FILLED where a column is empty.')
  console.log('  Nothing here can change a status, a note, a next action or a contact name.')
}

async function apply(supabase: Supabase, plan: ImportPlan): Promise<void> {
  for (const { id, patch } of plan.updates) {
    const { error } = await supabase.from('prospect_accounts').update(patch).eq('id', id)
    if (error) throw new Error(`update ${id}: ${error.message}`)
  }
  for (let at = 0; at < plan.inserts.length; at += CHUNK) {
    const { error } = await supabase.from('prospect_accounts').insert(plan.inserts.slice(at, at + CHUNK))
    if (error) throw new Error(`insert chunk at ${at}: ${error.message}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const supabase = connect()

  const scraped = await loadIcpRows(supabase, args.includes('--sized-only'))
  const mapped = scraped
    .map(toProspectUpsert)
    .filter((r): r is ProspectUpsert => r !== null)

  const plan = planStrProspectSync(mapped, await loadExisting(supabase))
  printPlan(plan, mapped.length)

  if (args.includes('--plan')) {
    console.log('')
    console.log('--plan: NOTHING WRITTEN.')
    return
  }

  await apply(supabase, plan)
  console.log('')
  console.log(`added ${plan.inserts.length}, filled ${plan.updates.length}.`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
