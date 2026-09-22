/**
 * One-time (and safely repeatable) backfill: splits prospect_accounts.pms
 * into a canonical product name plus the evidence for it in pms_note.
 *
 * Usage:
 *   pnpm exec tsx scripts/prospecting/normalize-pms.ts --plan
 *   pnpm exec tsx scripts/prospecting/normalize-pms.ts
 *
 * --plan reads the database and writes nothing: it prints the full
 * before → after mapping and the resulting brand list. Read it before
 * running without --plan. There is no --dry-run because there is no file to
 * parse; the live column IS the input.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A MIGRATION ────────────────────────────────
 *
 * The mapping lives in lib/prospecting/normalize.ts, in one alias table that
 * the admin import wizard also uses. Re-expressing that table as SQL inside a
 * migration would mean two copies of the same list, drifting apart the first
 * time a PMS is added to one of them — and the SQL copy would be the one
 * nobody remembers. A data backfill whose rule is application logic belongs
 * where that logic already is.
 *
 * ── WHY IT IS SAFE TO RUN TWICE ─────────────────────────────────────────────
 *
 * normalizePms() is idempotent: a value it has already canonicalised contains
 * no parenthetical and matches its own alias, so the second pass computes the
 * identical pair and the row is reported as unchanged rather than rewritten.
 * Evidence is appended to pms_note only when it is not already a substring of
 * it, so a re-run does not stack duplicate fingerprints.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It never clears a pms_note a human wrote, and it never invents a product.
 * A cell holding prose rather than a product name ("website directs to
 * AirBnB") moves wholesale into pms_note and leaves pms NULL — the honest
 * outcome, and the one the facet dropdown needs.
 */
import { normalizePms } from '../../lib/prospecting/normalize'
import { connect } from './connect'

interface Row {
  id:       string
  company:  string
  pms:      string | null
  pms_note: string | null
}

interface Change {
  id:      string
  company: string
  from:    string
  toPms:   string | null
  toNote:  string | null
}

const PAGE = 1000

/** Every row that has a pms value; the table is thousands of rows, not millions. */
async function loadRows(supabase: ReturnType<typeof connect>): Promise<Row[]> {
  const all: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('prospect_accounts')
      .select('id, company, pms, pms_note')
      .not('pms', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`loadRows: ${error.message}`)
    const batch = (data ?? []) as Row[]
    all.push(...batch)
    if (batch.length < PAGE) return all
  }
}

/**
 * Merges new evidence into an existing note without duplicating it.
 *
 * Only 2 of the 160 rows carrying a fingerprint have a pms_note today, but
 * "only two" is exactly how a note written by a person gets overwritten.
 */
function mergeNote(existing: string | null, evidence: string | null): string | null {
  if (evidence === null) return existing
  if (existing === null || existing.trim() === '') return evidence
  if (existing.includes(evidence)) return existing
  return `${existing} | ${evidence}`
}

function planChanges(rows: Row[]): Change[] {
  const changes: Change[] = []
  for (const row of rows) {
    if (row.pms === null) continue
    const { pms, evidence } = normalizePms(row.pms)
    const note = mergeNote(row.pms_note, evidence)
    if (pms === row.pms && note === row.pms_note) continue
    changes.push({ id: row.id, company: row.company, from: row.pms, toPms: pms, toNote: note })
  }
  return changes
}

function printPlan(rows: Row[], changes: Change[]): void {
  const before = new Set(rows.map((r) => r.pms).filter((v): v is string => v !== null))
  const after = new Set<string>()
  for (const row of rows) {
    const change = changes.find((c) => c.id === row.id)
    const value = change ? change.toPms : row.pms
    if (value !== null) after.add(value)
  }

  const byMapping = new Map<string, number>()
  for (const c of changes) {
    const key = `${c.from}  →  ${c.toPms ?? '(none)'}`
    byMapping.set(key, (byMapping.get(key) ?? 0) + 1)
  }

  console.log('')
  console.log(`rows with a pms value: ${rows.length}`)
  console.log(`distinct pms values:   ${before.size} → ${after.size}`)
  console.log(`rows that would change: ${changes.length}`)
  console.log('')
  console.log('mapping (old value → new value, row count):')
  for (const [mapping, n] of [...byMapping].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${mapping}`)
  }
  console.log('')
  console.log('resulting brands:')
  console.log(`  ${[...after].sort((a, b) => a.localeCompare(b)).join(', ')}`)
}

async function apply(supabase: ReturnType<typeof connect>, changes: Change[]): Promise<void> {
  for (const change of changes) {
    const { error } = await supabase
      .from('prospect_accounts')
      .update({ pms: change.toPms, pms_note: change.toNote })
      .eq('id', change.id)
    if (error) throw new Error(`update ${change.id} (${change.company}): ${error.message}`)
  }
}

async function main(): Promise<void> {
  const supabase = connect()
  const rows = await loadRows(supabase)
  const changes = planChanges(rows)

  if (process.argv.includes('--plan')) {
    printPlan(rows, changes)
    console.log('')
    console.log('--plan: NOTHING WRITTEN.')
    return
  }

  printPlan(rows, changes)
  await apply(supabase, changes)
  console.log('')
  console.log(`updated ${changes.length} row(s).`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
