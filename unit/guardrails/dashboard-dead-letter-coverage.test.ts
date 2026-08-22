import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DASHBOARD_UPLOAD_HANDLERS } from '@/lib/dexie/dashboard/syncService'

// ============================================================================
// THE CREW GUARDRAIL, EXTENDED TO THE SECOND SURFACE — the deliverable
// docs/INSPECTIONS_SPEC.md §10 names for phase 2a.
//
// `crew-dead-letter-coverage` exists because a pre-launch audit found retry
// affordances for three of nine crew mutation types: checklist ticks, inventory
// counts, availability, WO reports, asset captures and turnover start/complete
// all dead-lettered in total silence. §8 says the dashboard raises those stakes
// rather than changing them — "an evicted inspection draft is a wasted visit;
// an evicted work order is a repair nobody knows was requested" — and warns
// that a dashboard outbox built alongside the crew one would be "unguarded by
// all of them".
//
// This is that guard. It is deliberately NOT a copy: where the crew version
// greps `UPLOAD_HANDLERS` for each member of a string union, the dashboard
// registry is a `Record<DashboardMutationKind, …>`, so handler exhaustiveness
// is a COMPILE error and this file only has to check what the type system
// cannot see — the UI half.
// ============================================================================

const ROOT = join(__dirname, '..', '..')

const SCHEMA_SRC = readFileSync(join(ROOT, 'lib/dexie/dashboard/schema.ts'), 'utf8')
const BANNER_SRC = readFileSync(join(ROOT, 'app/(dashboard)/_components/dashboard-sync-banner.tsx'), 'utf8')
const LAYOUT_SRC = readFileSync(join(ROOT, 'app/(dashboard)/layout.tsx'), 'utf8')

/** Every member of the DashboardMutationKind union, read from the source. */
function mutationKinds(): string[] {
  const decl = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf('export type DashboardMutationKind ='))
  const body = decl.slice(0, decl.indexOf('\n\n'))
  return [...body.matchAll(/'([\w.]+)'/g)].map((m) => m[1]!)
}

describe('guardrail: every dashboard mutation kind has a dead-letter surface', () => {
  it('the union parses and is non-empty', () => {
    // A scan that found nothing would pass every test below for free.
    const kinds = mutationKinds()
    expect(kinds.length, 'failed to parse DashboardMutationKind — has its shape changed?')
      .toBeGreaterThan(0)
  })

  it('MUTATION_LABELS covers every kind, so nothing dead-letters unnamed', () => {
    const labelBlock = BANNER_SRC.slice(BANNER_SRC.indexOf('MUTATION_LABELS'))
    const missing = mutationKinds().filter((k) => !labelBlock.includes(`'${k}'`))

    expect(missing, [
      'These mutation kinds can dead-letter but have no MUTATION_LABELS entry in',
      'app/(dashboard)/_components/dashboard-sync-banner.tsx, so a PM whose write',
      'never reached the server would be shown a bare "Saved change" — or',
      'nothing at all. Add a label a PM would recognise:',
      ...missing,
    ].join('\n')).toEqual([])
  })

  it('every kind has an upload handler', () => {
    // The Record type already makes this a compile error; asserted at RUNTIME
    // too because a handler could be present and undefined (a spread, a
    // conditional build), and `undefined(m)` inside the drain throws a
    // TypeError that dead-letters with a stack trace instead of a reason.
    for (const kind of mutationKinds()) {
      const handler = (DASHBOARD_UPLOAD_HANDLERS as Record<string, unknown>)[kind]
      expect(typeof handler, `no upload handler for "${kind}"`).toBe('function')
    }
  })

  it('the banner is rendered by the dashboard layout, so it covers every screen', () => {
    expect(LAYOUT_SRC, 'the dashboard sync banner is not mounted anywhere')
      .toContain('<DashboardSyncBanner')
  })

  it('both outboxes are covered by BOTH the dead-letter and the stalled surface', () => {
    // The crew version of this test was written after finding photos covered by
    // NEITHER: a transport failure never sets `failed`, so they fell out of the
    // dead-letter query, and the stalled notice only looked at mutations. A
    // whole shift of photos could retry forever against a captive portal with
    // nothing on screen. Same two queues here, same two queries required.
    for (const table of ['mutations', 'pending_photo_uploads']) {
      expect(
        new RegExp(`db\\.${table}[\\s\\S]{0,120}?failed`).test(BANNER_SRC),
        `${table} has no dead-letter query in the dashboard banner`,
      ).toBe(true)

      expect(
        new RegExp(`db\\.${table}[\\s\\S]{0,200}?STALLED_NETWORK_ATTEMPTS`).test(BANNER_SRC),
        `${table} has no stalled-queue query in the dashboard banner — a transport ` +
        'failure never dead-letters, so this is its ONLY visible surface',
      ).toBe(true)
    }
  })

  it('the banner offers a retry, not just a notice', () => {
    expect(BANNER_SRC).toContain('retryAllFailedDashboardMutations')
    expect(BANNER_SRC).toContain('discardFailedDashboardMutation')
  })

  it('the dead-letter queries are index-backed, not full scans', () => {
    // Live queries on a table the drain writes to. As `.filter()` scans they
    // re-read the whole outbox on every write, on every dashboard screen —
    // which only became avoidable when `failed` stopped being a boolean,
    // since IndexedDB cannot index one.
    expect(
      /db\.mutations\s*\n?\s*\.where\('failed'\)\.equals\(1\)/.test(BANNER_SRC)
      || BANNER_SRC.includes("db.mutations.where('failed').equals(1)"),
      'the failed-mutation query must use the `failed` index',
    ).toBe(true)
    expect(
      BANNER_SRC.includes("db.pending_photo_uploads.where('failed').equals(1)"),
      'the failed-photo query must use the `failed` index',
    ).toBe(true)
  })

  it('the outbox indexes `failed` on both queues, or the queries above cannot work', () => {
    // The UI half is only half. An index-backed query against a store that
    // never declared the index silently returns nothing in some engines and
    // throws in others; either way the banner goes quiet.
    const storesBlock = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf('this.version(1).stores('))
    for (const table of ['mutations', 'pending_photo_uploads']) {
      const line = storesBlock.split('\n').find((l) => l.trim().startsWith(`${table}:`))
      expect(line, `${table} is not declared in the dashboard schema`).toBeDefined()
      expect(line, `${table} does not index \`failed\``).toContain('failed')
    }
  })

  it('the dashboard outbox builds on the shared engine rather than forking it', () => {
    // §8: "generalize lib/dexie to serve both surfaces, do not fork it." The
    // offline gate, cross-tab lock, in-order stop, backoff and dead-lettering
    // were each paid for with a production bug; a second implementation means
    // paying twice.
    const sync = readFileSync(join(ROOT, 'lib/dexie/dashboard/syncService.ts'), 'utf8')
    expect(sync, 'the dashboard outbox does not use OutboxEngine').toContain('new OutboxEngine')
    expect(
      sync.includes("from '../syncService'"),
      'the dashboard outbox imports the CREW sync service — share primitives, not surfaces',
    ).toBe(false)
  })

  it('the enqueue writes the local change and the outbox row in ONE transaction', () => {
    // CLAUDE.md, bought with a real bug: as two transactions, a PWA reclaimed
    // between them left the cache updated with nothing queued to send it — and
    // no delta pull corrects that, because the server row's updated_at never
    // changed. The drain kick must stay OUTSIDE, since an IndexedDB transaction
    // auto-commits the moment an await leaves it.
    const sync = readFileSync(join(ROOT, 'lib/dexie/dashboard/syncService.ts'), 'utf8')
    const fn = sync.slice(sync.indexOf('export async function enqueueDashboardMutation'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))

    expect(body, 'enqueueDashboardMutation must use a Dexie transaction').toContain('db.transaction(')
    const txStart = body.indexOf('db.transaction(')
    const kick    = body.indexOf('processOutbox')
    expect(kick, 'enqueueDashboardMutation never kicks the drain').toBeGreaterThan(-1)
    expect(kick, 'the processOutbox kick is inside the transaction — it will auto-commit early')
      .toBeGreaterThan(body.indexOf('})', txStart))
  })
})
