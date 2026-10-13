import { describe, it, expect } from 'vitest'
import { collectSourceFiles, readCode, rel } from './scan'

/**
 * GUARDRAIL — `work_orders.scheduled_date` / `scheduled_time` are deprecated,
 * and no NEW code may read or write them.
 *
 * WHY THIS EXISTS, specifically. The 2026-10-11 date split
 * (20261011120000) replaced one overloaded column with two:
 * `needed_by_date` (the PM's deadline) and `vendor_scheduled_at` (the vendor's
 * appointment). The migration kept the old pair rather than renaming them,
 * because PostgREST select strings are untyped literals and a rename would turn
 * ~40 compile-time-invisible call sites into runtime errors.
 *
 * That decision is sound and it has a cost: a missed call site does not fail to
 * build, it just keeps reading a column nothing writes any more. The first pass
 * at the migration missed ten of them because the sweeping `grep` was truncated
 * at 40 lines, and three of those were WRITE paths — the auto-WO creation in
 * `cron/maintenance-schedules-helpers.ts`, `cron/work-order-ops.ts` and
 * `createWorkOrderFromSchedule`. Every work order those created would have
 * carried `scheduled_date` and a NULL `needed_by_date`, which means vanishing
 * from the maintenance calendar, from the crew PWA's today column, and from the
 * vendor on-time denominator, with nothing raised anywhere.
 *
 * A grep is not a gate. This is.
 *
 * EXCEPTIONS is shrink-only: each entry is a deliberate remaining use with the
 * reason it is sound. Fix the call site, never add a line here.
 */

const DEPRECATED = /\bscheduled_(date|time)\b/

/**
 * `path:line` → why this use is legitimate.
 *
 * Checked for staleness too, so an entry cannot drift onto an unrelated line
 * and keep waving something through.
 */
const EXCEPTIONS: Record<string, string> = {
  'app/api/work-orders/route.ts:196':
    'Backward compatibility, deliberately. A tablet can hold a work-order create queued in its outbox from before the date split shipped, and that payload carries scheduled_date. Reading only the new key would silently drop the deadline off every such replay.',
  'lib/dexie/schema.ts:395':
    'A HISTORICAL Dexie version (5). Dexie replays versions in order on an existing device, so editing a shipped stores() makes the upgrade path depend on which version that device last opened. Superseded by version 14, which indexes the new columns.',
  'lib/dexie/schema.ts:432':
    'The same, for version 8.',

  // ── scheduled_time only, and still LIVE ────────────────────────────────────
  // The PM's optional hard time limit for a same-day flip. Deprecated as a
  // column, but it remains the only timezone-safe representation of one: it is
  // rendered against the property's own zone when the dispatch email and SMS
  // are built, before any vendor has accepted and named their own window.
  // These retire together once vendor_scheduled_window covers the case.
  'app/(dashboard)/maintenance/CreateWorkOrderModal.tsx:424':
    'The hard-time-limit input.',
  'app/(dashboard)/maintenance/actions.ts:181':
    'Reads that input off the create form.',
  'app/(dashboard)/maintenance/create-work-order-helpers.ts:47':
    'Carries it on the create input type.',
  'app/(dashboard)/maintenance/create-work-order-helpers.ts:374':
    'Writes it on create. Without this the input above posts into nothing and the dispatch window can never be set, which is exactly what happened for one commit during the date split.',
  'app/api/work-orders/route.ts:198':
    'Explicitly null: the offline create form has no time field, and naming the column is how that stays visible rather than being an omission.',
  'lib/inngest/functions/work-order-events-helpers.ts:69':
    'Selects it for the dispatch window.',
  'lib/inngest/functions/work-order-events-helpers.ts:103':
    'Pairs it with needed_by_date to build the window.',
  'lib/inngest/functions/work-order-events-helpers.ts:107':
    'Formats it.',
  'lib/inngest/functions/work-order-vendor-assigned.ts:34':
    'The same select, on the Inngest dispatch path.',
  'lib/inngest/functions/work-order-vendor-assigned.ts:274':
    'The same pairing.',
  'lib/inngest/functions/work-order-vendor-assigned.ts:278':
    'The same formatting.',
}

describe('guardrail: deprecated work-order date columns', () => {
  const files = collectSourceFiles(['app', 'lib', 'components'])

  it('has no unregistered reader or writer', () => {
    const offenders: string[] = []

    for (const file of files) {
      // readCode() strips comments: the migration and several of these files
      // NAME the deprecated columns in prose explaining the deprecation, and a
      // scanner that reads those is reporting its own documentation.
      const lines = readCode(file).split('\n')
      lines.forEach((line, i) => {
        if (!DEPRECATED.test(line)) return
        const key = `${rel(file)}:${i + 1}`
        if (EXCEPTIONS[key]) return
        offenders.push(`${key}: ${line.trim().slice(0, 100)}`)
      })
    }

    expect(
      offenders,
      'These read or write a DEPRECATED work_orders column. Use needed_by_date '
      + '(the PM deadline) or vendor_scheduled_at + vendor_scheduled_window '
      + '(the vendor appointment). A missed site does not fail to build, it '
      + 'quietly reads a column nothing writes.\n' + offenders.join('\n'),
    ).toEqual([])
  })

  it('has no stale exception', () => {
    const stale: string[] = []

    for (const [key, reason] of Object.entries(EXCEPTIONS)) {
      const [path, lineNo] = key.split(':')
      const file = files.find((f) => rel(f) === path)
      if (!file) { stale.push(`${key} (file is gone) — ${reason.slice(0, 60)}`); continue }

      const line = readCode(file).split('\n')[Number(lineNo) - 1]
      if (line === undefined || !DEPRECATED.test(line)) {
        stale.push(`${key} no longer names a deprecated column`)
      }
    }

    expect(
      stale,
      'An exception drifted off its line. Re-point it, or delete it if the use '
      + 'is gone. A stale entry protects nothing and hides the next real one.\n'
      + stale.join('\n'),
    ).toEqual([])
  })
})

describe('guardrail self-check: the scan fires', () => {
  it('matches a read, a write and a select-string use', () => {
    // A broken checker and a clean tree both report zero, so the pattern is
    // asserted against each shape it has to catch.
    expect(DEPRECATED.test("      .eq('scheduled_date', scheduledDate)")).toBe(true)
    expect(DEPRECATED.test('        scheduled_date:     scheduledDate,')).toBe(true)
    expect(DEPRECATED.test("        id, title, scheduled_date, estimated_cost,")).toBe(true)
    expect(DEPRECATED.test('  if (wo.scheduled_time && wo.needed_by_date) {')).toBe(true)
  })

  it('does not match the replacement columns', () => {
    expect(DEPRECATED.test("      needed_by_date:     scheduledDate,")).toBe(false)
    expect(DEPRECATED.test("        vendor_scheduled_at, vendor_scheduled_window,")).toBe(false)
    // A local variable named scheduledDate is not a column.
    expect(DEPRECATED.test('    const scheduledDate = schedule.next_due_date')).toBe(false)
  })
})
