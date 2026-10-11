import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { readCode } from './scan'
import {
  VENDOR_PROGRESS_VALUES,
  VENDOR_DECLINE_REASONS,
  woStatusForProgress,
  releasesVendor,
  blocksOnPm,
  isSelectableByVendor,
  vendorProgressLabel,
  vendorDeclineReasonLabel,
  type VendorProgress,
} from '@/lib/work-orders/vendor-progress'

/**
 * GUARDRAIL — the vendor_progress axis stays total, and stays the ONLY place
 * vendor_progress is related to wo_status.
 *
 * THE DEFECT THIS ENCODES. wo_status has sixteen hardcoded open-status filter
 * lists reading it across the board, /ops, the metrics snapshot, PM
 * notifications, the aging escalation and the inspection fan-out, every one a
 * literal array. Widening that enum drops a work order out of all of them with
 * no symptom. vendor_progress exists so the enum never has to widen, and that
 * only holds while every progress value has a decided lifecycle status and
 * nothing maps the two for itself.
 *
 * The compiler already catches a MISSING key (STATUS_BY_PROGRESS is a Record
 * over the union). What it cannot catch is the Postgres enum and the TS union
 * drifting apart, or a second mapping appearing somewhere else, so those are
 * checked here.
 */

const ROOT = join(__dirname, '..', '..')
const MIGRATION = 'supabase/migrations/20261011130000_vendor_progress_and_tech_grants.sql'

/**
 * Strips SQL line comments, quote-aware.
 *
 * NOT a third hand-rolled lexer in the sense CLAUDE.md bans: scan.ts's lexer
 * parses TypeScript and has no concept of `--`, and this reads .sql. It is
 * deliberately minimal — `--` to end of line, skipping anything inside a
 * single-quoted literal (where `''` is an escaped quote, as Postgres spells it).
 *
 * It exists because the FIRST version of this file did not have it, and the
 * enum parser below read 'pending' and 'quote_requested' out of a COMMENT that
 * sits inside the CREATE TYPE parentheses explaining the forward-only dispatch
 * filter. That is exactly the comment-blindness class CLAUDE.md documents, hit
 * inside a guardrail written to prevent a different drift.
 */
/** Index just past the single-quoted literal starting at `open`. */
function endOfSqlLiteral(sql: string, open: number): number {
  let i = open + 1
  while (i < sql.length) {
    if (sql[i] !== "'") { i += 1; continue }
    // Postgres doubles an embedded quote, so '' is content, not a terminator.
    if (sql[i + 1] === "'") { i += 2; continue }
    return i + 1
  }
  return i
}

/** Index of the newline ending the line comment at `open`, or end of input. */
function endOfSqlLineComment(sql: string, open: number): number {
  const nl = sql.indexOf('\n', open)
  return nl === -1 ? sql.length : nl
}

function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = endOfSqlLiteral(sql, i)
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i = endOfSqlLineComment(sql, i)
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/** The labels in a `CREATE TYPE ... AS ENUM (...)` block, in declared order. */
function enumLabels(sql: string, typeName: string): string[] {
  const re = new RegExp(`CREATE TYPE public\\.${typeName} AS ENUM \\(([^)]*)\\)`, 's')
  const body = re.exec(stripSqlComments(sql))?.[1]
  if (!body) throw new Error(`${typeName} not found in ${MIGRATION}`)
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
}

/**
 * Progress values that are NOT also labels of some other enum in this schema.
 *
 * 'declined' is a quote_request_status label too, so a file doing ordinary
 * quote work (declineQuoteRequest sets status 'declined' on quote_requests)
 * looks identical to one hand-rolling this mapping. Narrowing to the
 * unambiguous labels is what makes the cross-file check mean its name — the
 * naive version reported app/(dashboard)/maintenance/actions.ts, which maps
 * nothing.
 */
const UNAMBIGUOUS_PROGRESS: readonly VendorProgress[] = VENDOR_PROGRESS_VALUES.filter(
  (p) => p !== 'declined',
)

describe('guardrail: vendor_progress mapping', () => {
  it('maps every progress value to a lifecycle status', () => {
    for (const progress of VENDOR_PROGRESS_VALUES) {
      const status = woStatusForProgress(progress)
      expect(status, `${progress} has no wo_status`).toBeTruthy()
      expect(
        ['pending', 'quote_requested', 'assigned', 'in_progress', 'completed', 'cancelled'],
        `${progress} maps to a status outside wo_status`,
      ).toContain(status)
    }
  })

  it('agrees with the Postgres enum, label for label', () => {
    // readCode() parses TypeScript and leaves SQL `--` comments intact, so the
    // stripping happens in enumLabels() via stripSqlComments(). See its header
    // for the false reading that made this necessary.
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8')

    expect(enumLabels(sql, 'vendor_progress').sort())
      .toEqual([...VENDOR_PROGRESS_VALUES].sort())
    expect(enumLabels(sql, 'vendor_decline_reason').sort())
      .toEqual([...VENDOR_DECLINE_REASONS].sort())
  })

  it('labels every value, with no em dash in the copy', () => {
    for (const progress of VENDOR_PROGRESS_VALUES) {
      const label = vendorProgressLabel(progress)
      expect(label, `${progress} has no label`).toBeTruthy()
      expect(label, `${progress}'s label contains an em dash`).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/)
    }
    for (const reason of VENDOR_DECLINE_REASONS) {
      const label = vendorDeclineReasonLabel(reason)
      expect(label, `${reason} has no label`).toBeTruthy()
      expect(label, `${reason}'s label contains an em dash`).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/)
    }
  })

  it('releases the vendor only on the two values that return the WO to the queue', () => {
    // pending, not a dead end: dispatchWorkOrderToVendor advances status behind
    // a forward-only .in('status', ['pending','quote_requested']) filter, so
    // anything else leaves the work order permanently un-redispatchable.
    const released = VENDOR_PROGRESS_VALUES.filter(releasesVendor)
    expect(released).toEqual(['declined', 'cancelled_by_vendor'])
    for (const p of released) expect(woStatusForProgress(p)).toBe('pending')
  })

  it('treats exactly the two blocked states as needing the PM', () => {
    expect(VENDOR_PROGRESS_VALUES.filter(blocksOnPm))
      .toEqual(['awaiting_access', 'hold_pm_approval'])
  })

  it('keeps job_completed out of the vendor-selectable set', () => {
    // A dropdown that could write status 'completed' directly would be a second
    // completion path, skipping the work-order/completed event (and so the
    // owner_transactions maintenance expense), completed_date, the
    // work_order_updates row and the source-schedule advance.
    expect(isSelectableByVendor('job_completed')).toBe(false)
    const others = VENDOR_PROGRESS_VALUES.filter((p) => p !== 'job_completed')
    for (const p of others) expect(isSelectableByVendor(p)).toBe(true)
  })

  it('is the only module relating vendor_progress to wo_status', () => {
    // A second mapping is how the two axes drift into disagreeing about the
    // same work order, each looking correct where it sits. Any other file that
    // wants the lifecycle status must call woStatusForProgress().
    const files = execFiles()
    const offenders: string[] = []

    for (const file of files) {
      if (file.endsWith('lib/work-orders/vendor-progress.ts')) continue
      const code = readCode(join(ROOT, file))
      // A literal progress value sitting next to a literal wo_status value is
      // the shape of a hand-rolled mapping.
      const namesProgress = UNAMBIGUOUS_PROGRESS.some((p) => code.includes(`'${p}'`))
      const namesStatus = /status:\s*'(pending|assigned|in_progress|completed)'/.test(code)
      if (namesProgress && namesStatus) offenders.push(file)
    }

    expect(offenders, 'these files appear to map vendor_progress to wo_status themselves').toEqual([])
  })
})

/** Tracked .ts/.tsx under app/ and lib/. */
function execFiles(): string[] {
  return execSync('git ls-files "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts" "lib/**/*.tsx"', {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\n').filter(Boolean)
}

describe('guardrail self-check: the scan fires', () => {
  it('detects a hand-rolled mapping in a fixture', () => {
    // A broken checker and a clean tree both return zero offenders, so the
    // scan is asserted to catch the thing it is looking for.
    const fixture = `
      function woStatus(p: string) {
        if (p === 'tech_on_site') return { status: 'in_progress' }
        return null
      }
    `
    const namesProgress = UNAMBIGUOUS_PROGRESS.some((p) => fixture.includes(`'${p}'`))
    const namesStatus = /status:\s*'(pending|assigned|in_progress|completed)'/.test(fixture)
    expect(namesProgress && namesStatus).toBe(true)
  })

  it('does not fire on a file that names only one of the two', () => {
    const control = `const x = { status: 'in_progress' }`
    const namesProgress = UNAMBIGUOUS_PROGRESS.some((p) => control.includes(`'${p}'`))
    expect(namesProgress).toBe(false)
  })

  it('strips SQL comments before parsing the enum', () => {
    // Fire-check. The migration genuinely carries a comment INSIDE the
    // CREATE TYPE parentheses that quotes ['pending','quote_requested'], and
    // the first version of this file read those two as vendor_progress labels.
    // If stripping regresses, this is the test that says so.
    const raw = readFileSync(join(ROOT, MIGRATION), 'utf8')
    expect(raw).toMatch(/quote_requested/)
    expect(stripSqlComments(raw)).not.toMatch(/quote_requested/)

    // And it must not eat a legitimate '--' inside a string literal.
    expect(stripSqlComments("SELECT 'a--b' -- gone")).toBe("SELECT 'a--b' ")
    // Postgres doubles an embedded quote; the scanner must not end the literal
    // there and start treating SQL as string content.
    expect(stripSqlComments("SELECT 'it''s' -- gone")).toBe("SELECT 'it''s' ")
  })
})
