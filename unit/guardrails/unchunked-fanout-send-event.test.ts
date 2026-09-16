import { describe, it, expect } from 'vitest'
import { collectSourceFiles, readCode, rel } from './scan'

// ============================================================================
// Unchunked `step.sendEvent()` fan-out guardrail for lib/inngest/functions/**.
//
// The 2026-09-16 high-scale viability audit found the same shape at every
// platform-wide dispatcher in the codebase: build the WHOLE tenant/connection
// list with `.map()`, hand it to ONE `step.sendEvent()` call. Inngest enforces
// a per-call payload/event-count ceiling; a call built from a list sized by a
// live table scan (every active connection for a provider, every org on the
// platform) risks being rejected or truncated ATOMICALLY the moment that list
// crosses the ceiling — failing dispatch for every tenant in the batch that
// day, not just the ones past the limit. Two of the audit's CATASTROPHIC
// findings were exactly this (Hostex's platform-wide connection dispatcher,
// Hostaway's incremental-sync cron).
//
// The fix is `sendEventsChunked()` (lib/inngest/chunk.ts): same call shape,
// but splits into fixed-size batches, each its own named step so a chunk's
// dispatch failure doesn't replay the ones that already landed.
//
// This is a CLEAN-BASELINE RATCHET, same model as unbounded-select.test.ts —
// not a chokepoint, because the pattern is widespread enough (24 files at
// rollout) that gating every existing site at once would be a much larger,
// separately-scoped migration than the fix this guardrail exists to lock in.
// The baseline is SHRINK-ONLY: a file that switches to `sendEventsChunked`
// must be removed from it (enforced below via a self-check), and nothing may
// ever be added — every new fan-out dispatcher written from today onward must
// chunk from the start.
// ============================================================================

/**
 * Files that build a `step.sendEvent()` call from a `.map()`-derived array
 * with no chunking, grandfathered at guardrail rollout (2026-09-16). Each is
 * a real platform-wide or org-wide fan-out whose list size is bounded only by
 * live table contents — none of these are "small fixed literal" exemptions.
 *
 * SHRINK-ONLY. Remove an entry the moment its file adopts sendEventsChunked();
 * never add one for a file written after this guardrail existed.
 */
const BASELINE = new Set([
  'lib/inngest/functions/capex-projections.ts',
  'lib/inngest/functions/depreciation-ledger.ts',
  'lib/inngest/functions/guidebook-daily-monitor.ts',
  'lib/inngest/functions/guidebook-pre-arrival-email-cron.ts',
  'lib/inngest/functions/guidebook-sms-evening-cron.ts',
  'lib/inngest/functions/guidebook-sms-morning-cron.ts',
  'lib/inngest/functions/guidebook-stay-extension-cron.ts',
  'lib/inngest/functions/hospitable/calendar-sync-cron.ts',
  'lib/inngest/functions/ical-sync.ts',
  'lib/inngest/functions/ownerrez/incremental-sync.ts',
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts',
  'lib/inngest/functions/ownerrez/reconciliation-cron.ts',
  'lib/inngest/functions/platform-inventory-template-broadcast.ts',
  'lib/inngest/functions/cron/asset-health.ts',
  'lib/inngest/functions/cron/comms-retention.ts',
  'lib/inngest/functions/cron/daily-wrapup.ts',
  'lib/inngest/functions/cron/guest-pii-retention.ts',
  'lib/inngest/functions/cron/integration-token-refresh.ts',
  'lib/inngest/functions/cron/maintenance-schedules.ts',
  'lib/inngest/functions/cron/work-order-ops.ts',
])

function findUnchunkedSendEventCalls(src: string): number[] {
  const lines: number[] = []
  let idx = 0
  while ((idx = src.indexOf('step.sendEvent(', idx)) !== -1) {
    // A bounded look-ahead window, not full bracket-matching: every offending
    // call site builds its event array within a few lines of the call
    // (`step.sendEvent('id', xs.map(...))`), and a window is what the
    // sibling unbounded-select-style guardrails already use for this shape
    // (see sensitive-data-logging's precedent). 700 chars comfortably covers
    // a multi-line `.map((x) => ({ name: ..., data: {...} }))` object literal.
    const window = src.slice(idx, idx + 700)
    if (window.includes('.map(')) {
      lines.push(src.slice(0, idx).split('\n').length)
    }
    idx += 'step.sendEvent('.length
  }
  return lines
}

describe('guardrail: chunked step.sendEvent() for unbounded fan-out', () => {
  const files = collectSourceFiles(['lib/inngest/functions'])

  it('every step.sendEvent(...map(...)) call site is baselined or chunked', () => {
    const violations: string[] = []

    for (const file of files) {
      const path = rel(file)
      const src = readCode(file)
      const offendingLines = findUnchunkedSendEventCalls(src)
      if (offendingLines.length === 0) continue
      if (BASELINE.has(path)) continue
      violations.push(
        `${path}:${offendingLines.join(',')} — unchunked step.sendEvent() built from .map(). ` +
        `Use sendEventsChunked() from lib/inngest/chunk.ts, or add a justified BASELINE entry ` +
        `if this is a genuinely small, fixed-size list.`,
      )
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('BASELINE is shrink-only: every entry is still a real, current offender', () => {
    const stale: string[] = []
    for (const path of BASELINE) {
      const full = files.find((f) => rel(f) === path)
      if (!full) {
        stale.push(`${path} — no longer exists; remove from BASELINE`)
        continue
      }
      if (findUnchunkedSendEventCalls(readCode(full)).length === 0) {
        stale.push(`${path} — already chunked; remove from BASELINE`)
      }
    }
    expect(stale, stale.join('\n')).toEqual([])
  })

  it('self-check: the scanner actually fires on an unchunked map() call', () => {
    const offender = `
      await step.sendEvent(
        'fan-out',
        orgIds.map((orgId) => ({ name: 'x/y', data: { orgId } })),
      )
    `
    expect(findUnchunkedSendEventCalls(offender).length).toBeGreaterThan(0)

    const control = `
      await sendEventsChunked(step, 'fan-out', orgIds.map((orgId) => ({ name: 'x/y', data: { orgId } })))
    `
    expect(findUnchunkedSendEventCalls(control)).toHaveLength(0)
  })
})
