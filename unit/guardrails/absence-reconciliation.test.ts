import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// ============================================================================
// RECONCILING BY ABSENCE — the destructive-by-default sync shape.
//
// "Fetch the upstream list, then delete/cancel/deactivate every local row that
// is missing from it" is the only way an upstream HARD DELETE is ever
// detectable, so this codebase uses it in five places. It also has one
// degenerate input that turns it into a data-destruction bug: an EMPTY fetched
// list means every local row is absent, so the pass removes all of them.
//
// This is not hypothetical. On 2026-07-18 at 09:00 UTC, hospTeammateSyncHandler
// deactivated all three of one org's Hospitable crew members at the same
// microsecond — one batch, the entire roster, one cron run — because
// hospFetchTeammates returned [] for a non-ok response and the deactivation
// pass had no empty-set guard. Every row got an audit entry claiming the person
// had been removed from Hospitable.
//
// THE INVARIANT: a fetch feeding an absence-based reconciliation must
// distinguish FAILURE from GENUINE EMPTINESS. There are exactly two valid ways,
// and which one is correct depends on whether empty is a legitimate steady
// state for that entity:
//
//   fetch-fails-loud  — the fetch throws (or returns null) on failure, so []
//                       can only mean "upstream really has none". Required
//                       where empty is NORMAL: a property with no calendar
//                       blocks, a crew member with no assignments. An empty-set
//                       guard would be WRONG here — it would make the last
//                       block or last assignment impossible to ever clear.
//
//   empty-set-guard   — the pass refuses to act on an empty set at all.
//                       Required where empty is IMPLAUSIBLE and the fetch
//                       cannot be trusted to fail loudly. Costs one stale row
//                       until the next run; the alternative costs the table.
//
// Registering a site is deliberate. Adding a NEW absence-based reconciliation
// fails this test until someone states which protection it has and why.
// ============================================================================

const DESTRUCTIVE = /bulkDelete\(|\.delete\(\)|status:\s*'cancelled'|is_active:\s*false|deleted_at:/
const ABSENCE     = /!\s*(\w+)\s*\.has\(/

interface Reconciler {
  protection: 'fetch-fails-loud' | 'empty-set-guard'
  why:        string
}

/**
 * Every absence-based reconciliation in the codebase, keyed by file:line.
 *
 * Shrink-only in spirit: a new entry needs a real justification, not a note
 * that the check was noisy.
 */
const RECONCILERS: Record<string, Reconciler> = {
  'lib/inngest/functions/ownerrez/reconciliation-handler.ts:163': {
    protection: 'empty-set-guard',
    why: 'Cancels FieldStay bookings absent from OwnerRez. An org with connected properties having zero bookings is implausible, and getBookings() can return a 200 with an empty body on an upstream hiccup — indistinguishable from a genuinely emptied account. Cancelling wrongly sends crew home from stays that are still happening.',
  },
  'lib/inngest/functions/hospitable/teammate-sync-handler.ts:112': {
    protection: 'empty-set-guard',
    why: 'Deactivates crew members absent from Hospitable. THE SITE THAT FIRED: hospFetchTeammates returned [] for any non-ok response, including the 403 expected for a connection without teammate:read, and did so from inside its pagination loop. Both halves are fixed, and the guard stays as the backstop because the caller cannot verify how the fetch failed.',
  },
  'lib/inngest/functions/hostex/staff-sync.ts:248': {
    protection: 'empty-set-guard',
    why: 'Deactivates crew members absent from Hostex /staffs. Same shape as the Hospitable teammate site above, and guarded the same way for the same reason: an account holding a Hostex connection and zero staff has nothing to reconcile anyway, so an empty fetch is far likelier to be a failure than a real state. Deactivating wrongly takes a whole roster out of auto-assign, which selects on is_active.',
  },
  'lib/inngest/functions/hospitable/calendar-sync-handler.ts:147': {
    protection: 'fetch-fails-loud',
    why: 'Cancels blocks absent from the Hospitable calendar. hospFetchCalendar THROWS on any non-ok, so [] can only mean the window genuinely holds no blocks — which is the normal state for most properties. An empty-set guard here would be a bug: the LAST lifted block could never be cleared.',
  },
  'lib/dexie/sync/turnovers.ts:109': {
    protection: 'fetch-fails-loud',
    why: 'Drops cached turnovers no longer assigned to this crew member. fetchAssignedTurnoverIds returns NULL on failure and syncAssignedTurnovers returns early on null, so [] means the crew member genuinely has no assignments — a normal state, and unassignment-to-zero must still clear the device.',
  },
  'lib/dexie/sync/work-orders.ts:177': {
    protection: 'fetch-fails-loud',
    why: 'Drops cached work orders outside the crew member\'s current set. Both deltaPull and idSnapshot return NULL on failure and resolveDeltaPull propagates it, so [] means genuinely none assigned.',
  },
  'lib/dexie/dashboard/inspection-sync.ts:122': {
    protection: 'fetch-fails-loud',
    why: "Reconciles ONE property's cached assets after pulling an inspection. The Supabase read returns { data, error } and the function returns early on error, so the bulkDelete is only ever reached with a genuinely complete list — and empty is a legitimate steady state here, because most properties have not catalogued their assets at all (8 of 29 in production). An empty-set guard would be WRONG: it would make the last asset impossible to retire, and a stale asset keeps opening §12.3's well section on a property with no well.",
  },
  'lib/dexie/dashboard/warm-inspections.ts:303': {
    protection: 'fetch-fails-loud',
    why: "The same reconciliation, batched across the properties with open inspections. Identical protection: the asset query's error branch returns before this block, having still cached the inspections themselves. The delete is scoped to the property_ids the fetch actually covered, so even a wrong empty result could not reach another property's cached assets.",
  },
  'lib/dexie/dashboard/warm-inspections.ts:211': {
    protection: 'fetch-fails-loud',
    why: "Drops cached PROPERTIES the org no longer has, so a removed property stops being offered as somewhere to start an inspection. cacheFormLibrary returns early on any of its four query errors, so this block only runs with a genuinely complete list. Empty is a legitimate steady state — a new org has no properties — and an empty-set guard would make the LAST property impossible to remove from a device. Note the sibling FORM tables in the same function are guarded the opposite way, and deliberately: an empty form library is never a real state, only a failed seed.",
  },
  'lib/dexie/dashboard/warm-inspections.ts:404': {
    protection: 'fetch-fails-loud',
    why: "Drops cached OPEN CONCERNS — the open work orders §6's repeat prompt asks about — once they are no longer open. The Supabase read's error branch returns before this block and deliberately leaves the cache alone, so the delete only runs on a genuinely complete list, and the scope is the property_ids the fetch covered. Empty is emphatically a legitimate steady state: most properties have no open inspection-sourced work order at all. An empty-set guard would be the bug here — a COMPLETED work order could never stop being offered as a predecessor, and the prompt would keep asking an inspector whether a finding matches a job that was finished months ago.",
  },
}

/**
 * A provider fetch that returns [] from an ERROR branch is the root cause the
 * teammate wipe came from: it manufactures the degenerate input above, and no
 * caller can tell the difference. Registered exceptions must be cases where
 * the empty result is semantically true, not merely convenient.
 */
const FAIL_SOFT_EMPTY_RETURNS: Record<string, string> = {
  // hospFetchReservationMessages' 404-returns-[] entry was here until
  // 2026-08-20. The function is gone: the message webhook carries the whole
  // message, so nothing fetches a thread any more.
  'lib/integrations/providers/hospitable.ts:822':
    'hospFetchTeammates: 403 is the one expected non-ok — a connection predating the teammate:read scope. Nothing about it is retriable. Every OTHER status now throws, and the sole absence-based consumer carries an empty-set guard.',
}

function sourceFiles(): string[] {
  return execSync('grep -rl "\\.has(" --include=*.ts --include=*.tsx lib app', { encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => f && !/\.test\.|\/stubs\//.test(f))
}

/**
 * Finds every "absence drives a destructive write" site.
 *
 * `setName` is the Set being tested for membership — carried out of the scan so
 * the empty-set-guard check can tie itself to THAT set rather than to any
 * emptiness check anywhere in the file. A file-wide search was the first
 * version and it was useless: teammate-sync-handler contains an unrelated
 * `if (!rows.length) return 0` in its upsert step, so deleting the real guard
 * still passed.
 */
function findReconcilerSites(): { site: string; setName: string }[] {
  const found: { site: string; setName: string }[] = []

  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')

    lines.forEach((line, i) => {
      const absence = line.match(ABSENCE)
      if (!absence) return
      const setName = absence[1]!

      // What the absence check feeds: either an accumulator on the same line
      // (`if (!set.has(x)) departed.add(x)`) or the const it is bound to.
      let bind: string | null = null
      const accumulator = line.match(/(\w+)\.add\(/)
      if (accumulator) bind = accumulator[1]!
      for (let b = i; !bind && b >= Math.max(0, i - 4); b--) {
        const m = lines[b]!.match(/(?:const|let)\s+(\w+)\s*=/)
        if (m) bind = m[1]!
      }
      if (!bind) return

      const after = lines.slice(i, i + 45)
      const body  = after.join('\n')
      if (!DESTRUCTIVE.test(body)) return

      // ONE-LINER FORM: the absence filter is an argument to the destructive
      // call itself — `bulkDelete(stale.filter((id) => !keep.has(id)))`. The
      // connection is syntactic and needs no further proof.
      //
      // This was a blind spot until 2026-08-23. The check below requires the
      // bound value to appear AFTER line i, and in this shape it appears only
      // ON line i — so two real reconcile-by-absence sites in
      // lib/dexie/dashboard/ passed the scan without ever being registered.
      // They were written by someone who had just read this file, which is the
      // best evidence that the gap was in the scan and not in the author.
      if (DESTRUCTIVE.test(line)) {
        found.push({ site: `${file}:${i + 1}`, setName })
        return
      }

      // Otherwise a destructive write must FOLLOW and must actually mention the
      // bound value — otherwise this is an additive "create what's missing"
      // filter, which is the common and harmless case.
      if (!new RegExp(`\\b${bind}\\b`).test(after.slice(1).join('\n'))) return

      found.push({ site: `${file}:${i + 1}`, setName })
    })
  }

  return found
}

const findReconcilers = (): string[] => findReconcilerSites().map((r) => r.site)

function findFailSoftEmptyReturns(): string[] {
  const found: string[] = []
  const files = execSync('ls lib/integrations/providers/*.ts', { encoding: 'utf8' })
    .trim().split('\n').filter((f) => f && !/\.test\./.test(f))

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/return \[\]/.test(line)) return
      // Is this inside an error/status branch? Look back a few lines.
      // 20 lines, not 8: an error branch can carry a long explanatory comment
      // between the status check and the return, and an 8-line window silently
      // missed exactly that shape when it was canaried.
      const before = lines.slice(Math.max(0, i - 20), i + 1).join('\n')
      if (!/!res\.ok|res\.status\s*===|catch\s*[({]/.test(before)) return
      found.push(`${file}:${i + 1}`)
    })
  }
  return found
}

describe('guardrail: reconciling by absence must survive an empty fetch', () => {
  it('every absence-driven destructive write is registered with its protection', () => {
    const unlisted = findReconcilers().filter((site) => !RECONCILES_KNOWN.has(site))

    expect(
      [
        unlisted.length === 0 ? '' :
          'A destructive write is driven by absence from a fetched set, and this site is not\n' +
          'registered. An EMPTY fetched list makes every local row absent, so this pass would\n' +
          'delete/cancel/deactivate all of them — that is exactly how one org\'s entire\n' +
          'Hospitable crew roster was deactivated in a single cron run on 2026-07-18.\n\n' +
          'Add it to RECONCILERS in this file, stating which protection it has:\n' +
          '  fetch-fails-loud — the fetch throws/returns null on failure, so [] is genuinely empty\n' +
          '  empty-set-guard  — the pass refuses to act on an empty set\n\n' +
          'Unregistered sites:',
        ...unlisted,
      ].filter(Boolean).join('\n'),
    ).toEqual('')
  })

  it('every registered site still exists at that file:line (prune when code moves)', () => {
    const live = new Set(findReconcilers())
    const stale = Object.keys(RECONCILERS).filter((site) => !live.has(site))

    expect(
      [
        stale.length === 0 ? '' :
          'A RECONCILERS entry no longer matches any absence-driven destructive write.\n' +
          'Line numbers drift — re-point it, or delete the entry if the code is gone.\n' +
          'A stale entry silently stops protecting anything.\n\nStale entries:',
        ...stale,
      ].filter(Boolean).join('\n'),
    ).toEqual('')
  })

  it('every empty-set-guard site actually contains an empty-set check', () => {
    // The registry records intent; this checks the intent was implemented.
    const bySite = new Map(findReconcilerSites().map((r) => [r.site, r.setName]))

    const missing = Object.entries(RECONCILERS)
      .filter(([, r]) => r.protection === 'empty-set-guard')
      .map(([site]) => site)
      .filter((site) => {
        const setName = bySite.get(site)
        if (!setName) return false          // staleness is the other test's job
        const src = readFileSync(site.split(':')[0]!, 'utf8')
        // The guard must name THE SET the absence check uses.
        return !new RegExp(`${setName}\\.(size|length)\\s*===\\s*0|!${setName}\\.(size|length)\\b`).test(src)
      })

    expect(
      [
        missing.length === 0 ? '' :
          'Registered as empty-set-guard, but the file has no empty-set check:',
        ...missing,
      ].filter(Boolean).join('\n'),
    ).toEqual('')
  })

  it('every registration carries a real justification', () => {
    for (const [site, r] of Object.entries(RECONCILERS)) {
      expect(r.why.length, `${site} needs a real reason`).toBeGreaterThan(60)
    }
  })

  it('no provider fetch returns [] from an error branch unless registered', () => {
    const unlisted = findFailSoftEmptyReturns().filter((s) => !(s in FAIL_SOFT_EMPTY_RETURNS))

    expect(
      [
        unlisted.length === 0 ? '' :
          'A provider fetch returns [] from an error branch. That manufactures the degenerate\n' +
          'input the reconcilers above must survive, and no caller can tell it apart from a\n' +
          'genuinely empty upstream. Throw instead — or register it here if the empty result\n' +
          'is semantically TRUE rather than merely convenient.\n\nUnregistered:',
        ...unlisted,
      ].filter(Boolean).join('\n'),
    ).toEqual('')
  })

  it('the scan itself fires — a broken checker looks exactly like a clean tree', () => {
    // Self-check: the two shapes this test exists to catch must both be
    // recognised. Without this, a regex typo turns the whole guardrail into a
    // permanently-passing no-op.
    const known = findReconcilers()
    expect(known).toContain('lib/inngest/functions/hospitable/teammate-sync-handler.ts:112')
    expect(known).toContain('lib/dexie/sync/work-orders.ts:177')   // accumulator shape
    expect(known.length).toBeGreaterThanOrEqual(5)
  })
})

const RECONCILES_KNOWN = new Set(Object.keys(RECONCILERS))
