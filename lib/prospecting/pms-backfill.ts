/**
 * Splitting prospect_accounts.pms into a canonical product plus the evidence
 * for it in pms_note.
 *
 * A LEAF module (only ./normalize, itself a leaf) so the admin button runs it
 * in the browser and scripts/prospecting/normalize-pms.ts runs the identical
 * code in node. The mapping must not exist twice: the whole point is that one
 * alias table decides what "Streamline" means.
 *
 * ── WHY THIS IS NOT A MIGRATION ─────────────────────────────────────────────
 *
 * The rule lives in lib/prospecting/normalize.ts, which the import wizard and
 * the scraper sync also use. Re-expressing that alias table as SQL would mean
 * two copies drifting apart the first time a PMS is added to one of them — and
 * the SQL copy is the one nobody remembers. A data backfill whose rule is
 * application logic belongs where that logic already is.
 *
 * ── WHY IT IS SAFE TO RUN TWICE ─────────────────────────────────────────────
 *
 * normalizePms() is idempotent: a value it has already canonicalised carries
 * no parenthetical and matches its own alias, so a second pass computes the
 * identical pair and the row is reported unchanged rather than rewritten.
 * Evidence is appended to pms_note only when it is not already a substring,
 * so a re-run cannot stack duplicate fingerprints.
 */
import { normalizePms } from './normalize'

/** The columns the backfill reads and writes. */
export const PMS_BACKFILL_COLUMNS = `id, company, pms, pms_note`

export interface PmsRow {
  id:       string
  company:  string
  pms:      string | null
  pms_note: string | null
}

export interface PmsChange {
  id:      string
  company: string
  /** The value as stored today, for the before/after listing. */
  from:    string
  toPms:   string | null
  toNote:  string | null
}

/**
 * Merges new evidence into an existing note without duplicating it.
 *
 * Only 2 of the 160 rows carrying a fingerprint have a pms_note today, but
 * "only two" is exactly how a note somebody wrote gets overwritten.
 */
export function mergeNote(existing: string | null, evidence: string | null): string | null {
  if (evidence === null) return existing
  if (existing === null || existing.trim() === '') return evidence
  if (existing.includes(evidence)) return existing
  return `${existing} | ${evidence}`
}

/** Every row whose pms or pms_note the normalizer would change. */
export function planPmsChanges(rows: readonly PmsRow[]): PmsChange[] {
  const changes: PmsChange[] = []
  for (const row of rows) {
    if (row.pms === null) continue
    const { pms, evidence } = normalizePms(row.pms)
    const note = mergeNote(row.pms_note, evidence)
    if (pms === row.pms && note === row.pms_note) continue
    changes.push({ id: row.id, company: row.company, from: row.pms, toPms: pms, toNote: note })
  }
  return changes
}

export interface PmsMapping {
  from:  string
  to:    string | null
  count: number
}

/** The old → new value mapping, most-affected first, for the preview. */
export function mappingSummary(changes: readonly PmsChange[]): PmsMapping[] {
  const byPair = new Map<string, PmsMapping>()
  for (const c of changes) {
    const key = `${c.from}\u0000${c.toPms ?? ''}`
    const seen = byPair.get(key)
    if (seen === undefined) byPair.set(key, { from: c.from, to: c.toPms, count: 1 })
    else seen.count += 1
  }
  return [...byPair.values()].sort((a, b) => b.count - a.count)
}

/** The distinct product names the column would hold afterwards. */
export function brandsAfter(rows: readonly PmsRow[], changes: readonly PmsChange[]): string[] {
  const byId = new Map(changes.map((c) => [c.id, c]))
  const brands = new Set<string>()
  for (const row of rows) {
    const change = byId.get(row.id)
    const value = change ? change.toPms : row.pms
    if (value !== null) brands.add(value)
  }
  return [...brands].sort((a, b) => a.localeCompare(b))
}

/** The distinct product names the column holds today. */
export function brandsBefore(rows: readonly PmsRow[]): string[] {
  const brands = new Set<string>()
  for (const row of rows) if (row.pms !== null) brands.add(row.pms)
  return [...brands].sort((a, b) => a.localeCompare(b))
}
