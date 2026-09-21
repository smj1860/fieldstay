import { describe, it, expect } from 'vitest'
import { collectSourceFiles, readCode, rel } from './scan'

// ============================================================================
// Tenant-keyed Inngest concurrency guardrail.
//
// The 2026-09-16 high-scale viability audit's most-repeated CATASTROPHIC/HIGH
// finding: an Inngest function declares `concurrency: { limit: N }` (or
// `concurrency: [{ limit: N }]`) with NO `key:` — a platform-wide ceiling
// shared by every tenant combined, not a per-tenant one. At 100x tenant
// growth, one busy org (or one slow external call) consumes the WHOLE budget
// and starves every other org's turn at that function — inventory
// consumption events, Hostaway/Hostex syncs, and friction scoring were each
// found doing exactly this.
//
// The fix is almost always `concurrency: [{ limit: N }, { key: 'event.data.org_id', limit: M }]`
// — a platform ceiling AND a per-tenant one, so no single org can exhaust the
// whole budget.
//
// This is a CLEAN-BASELINE RATCHET, same model as unbounded-select.test.ts,
// not a chokepoint: an unkeyed concurrency limit is not always wrong (a
// function serializing access to one genuinely global, singleton resource has
// no tenant to key on), so this needs case-by-case review rather than a
// zero-tolerance ban — but the review has to happen once, on purpose, not by
// default. The baseline is SHRINK-ONLY: a file that adds a tenant key (or
// documents why it deliberately has none, via BASELINE_JUSTIFIED) must leave
// BASELINE; nothing may be added beyond what existed at rollout.
// ============================================================================

/**
 * Files with an unkeyed `concurrency:` block, grandfathered at guardrail
 * rollout (2026-09-16), not yet individually reviewed for whether a tenant
 * key applies. SHRINK-ONLY — remove an entry once its function either adds a
 * `key:` or is moved to BASELINE_JUSTIFIED with a one-line reason.
 */
const BASELINE = new Set([
  'lib/inngest/functions/asset-manual-lookup.ts',
  'lib/inngest/functions/asset-scan.ts',
  'lib/inngest/functions/booking-events.ts',
  'lib/inngest/functions/capex-projections.ts',
  'lib/inngest/functions/crew-turnover-cancelled.ts',
  'lib/inngest/functions/depreciation-ledger.ts',
  'lib/inngest/functions/guidebook-daily-monitor.ts',
  'lib/inngest/functions/guidebook-pre-arrival-email-cron.ts',
  'lib/inngest/functions/guidebook-sms-evening-cron.ts',
  'lib/inngest/functions/guidebook-sms-morning-cron.ts',
  'lib/inngest/functions/guidebook-stay-extension-cron.ts',
  'lib/inngest/functions/ical-sync.ts',
  'lib/inngest/functions/notify-integration-error.ts',
  'lib/inngest/functions/notify-vendor-compliance-expiring.ts',
  'lib/inngest/functions/ownerrez/incremental-sync.ts',
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts',
  'lib/inngest/functions/platform-inventory-template-broadcast.ts',
  'lib/inngest/functions/turnover-events.ts',
  'lib/inngest/functions/work-order-dispatch.ts',
  'lib/inngest/functions/work-order-events.ts',
  'lib/inngest/functions/work-order-vendor-assigned.ts',
  'lib/inngest/functions/cron/asset-health.ts',
  'lib/inngest/functions/cron/comms-retention.ts',
  'lib/inngest/functions/cron/daily-wrapup.ts',
  'lib/inngest/functions/cron/guest-pii-retention.ts',
  'lib/inngest/functions/cron/job-run-recorder.ts',
  'lib/inngest/functions/cron/maintenance-schedules.ts',
  'lib/inngest/functions/cron/work-order-ops.ts',
])

/**
 * Functions whose concurrency is deliberately platform-wide with no tenant
 * axis, reviewed and justified rather than merely grandfathered. Growing this
 * map is a real design decision — it should read like a code review comment,
 * not a rubber stamp.
 */
const BASELINE_JUSTIFIED: Record<string, string> = {
  'lib/inngest/functions/prospecting-crawl.ts':
    'prospect_accounts has no org_id — this is platform go-to-market data, not tenant data, so there is no tenant to key concurrency on. The limit:2 caps requests against the one genuinely global, singleton resource being protected (comparent.com itself, politeness budget), the same shape this guardrail\'s own header comment calls out as a legitimate unkeyed case.',
}

/** Matching close-bracket index for the bracket opened at `openIdx`. */
function matchingBracketEnd(src: string, openIdx: number): number {
  const openChar  = src[openIdx]
  const closeChar = openChar === '[' ? ']' : '}'
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openChar) depth++
    else if (src[i] === closeChar) {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length - 1
}

function findUnkeyedConcurrencyBlocks(src: string): number[] {
  const lines: number[] = []
  let idx = 0

  while ((idx = src.indexOf('concurrency:', idx)) !== -1) {
    const afterKeyword = idx + 'concurrency:'.length
    const openIdx = afterKeyword + src.slice(afterKeyword).search(/\S/)
    const openChar = src[openIdx]

    if (openChar !== '[' && openChar !== '{') {
      idx = afterKeyword
      continue
    }

    const end = matchingBracketEnd(src, openIdx)
    const block = src.slice(openIdx, end)
    if (!block.includes('key:')) {
      lines.push(src.slice(0, idx).split('\n').length)
    }
    idx = end + 1
  }

  return lines
}

describe('guardrail: tenant-keyed Inngest concurrency', () => {
  const files = collectSourceFiles(['lib/inngest/functions'])

  it('every unkeyed concurrency block is baselined, justified, or keyed', () => {
    const violations: string[] = []

    for (const file of files) {
      const path = rel(file)
      if (BASELINE.has(path) || path in BASELINE_JUSTIFIED) continue

      const offendingLines = findUnkeyedConcurrencyBlocks(readCode(file))
      if (offendingLines.length === 0) continue

      violations.push(
        `${path}:${offendingLines.join(',')} — concurrency config has no key: entry, ` +
        `so the limit is shared by every tenant combined. Add a tenant-scoped entry ` +
        `(e.g. { key: 'event.data.org_id', limit: N }) alongside the platform ceiling, ` +
        `or add a justified BASELINE_JUSTIFIED entry if this is deliberately global.`,
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
      if (findUnkeyedConcurrencyBlocks(readCode(full)).length === 0) {
        stale.push(`${path} — already keyed; remove from BASELINE`)
      }
    }
    expect(stale, stale.join('\n')).toEqual([])
  })

  it('self-check: the scanner fires on an unkeyed block and not a keyed one', () => {
    const offender = `
      inngest.createFunction(
        { id: 'x', concurrency: [{ limit: 5 }] },
        { event: 'x/y' },
        async () => {},
      )
    `
    expect(findUnkeyedConcurrencyBlocks(offender).length).toBeGreaterThan(0)

    const control = `
      inngest.createFunction(
        { id: 'x', concurrency: [{ limit: 25 }, { key: 'event.data.org_id', limit: 3 }] },
        { event: 'x/y' },
        async () => {},
      )
    `
    expect(findUnkeyedConcurrencyBlocks(control)).toHaveLength(0)
  })
})
