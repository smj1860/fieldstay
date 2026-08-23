import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// N+1 query guardrail: a Supabase query (or RPC call) inside a per-row loop
// body issues one round-trip per row instead of one batched call — CLAUDE.md's
// "Data Integrity & Concurrency" checklist bans this ("never issue one query
// per iteration of a loop... fetch every row needed in one query"), but until
// now nothing enforced it. Real, fixable instances of exactly this pattern
// existed in app/api/account/delete/route.ts and app/api/webhooks/telnyx/
// route.ts (both fixed via lib/audit.ts's logAuditEvents batch helper in the
// same change that added this guardrail).
//
// Scope: only PER-ROW iteration constructs are scanned — `for (const x of xs)`,
// `for await (const x of xs)`, `.forEach(`, `.map(async`. Classic numeric
// `for (let i = 0; i < n; i += CHUNK)` loops are excluded structurally: in
// this codebase they are always pagination/chunking (fetching or writing a
// bounded page/batch at a time), never per-row business-object iteration —
// see lib/inngest/functions/cron/notifications-retention.ts or
// checklist-signals.ts for the pattern this exclusion protects.
//
// Structural exemption: a `step.run(` call between the loop's opening brace
// and the query counts as the intentional Inngest per-item-step-boundary
// pattern (`for (const x of xs) { await step.run(...) }` — each item gets its
// own retry boundary) and is never flagged, no matter how many instances of
// it exist. This is NOT the same as a loop *nested inside* a single step.run
// body — that shape (`step.run(async () => { for (...) { query } })`) has no
// per-item retry boundary and IS flagged.
//
// That exemption is deliberately narrow, and it is NOT a blanket blessing of
// the shape: a per-item step boundary is only safe when the collection being
// iterated is bounded. `for (const row of everyRowOnThePlatform) { step.run }`
// is a step explosion, not an N+1, and this test says nothing about it — which
// is exactly why findings 4, 5, 11 and 12 of the 2026-07-30 pre-launch audit
// were invisible to CI. `unbounded-fanout-loops.test.ts` is the other half of
// this pair and covers precisely what this exemption lets through: it requires
// the iterated collection to carry an explicit bound (an org scope, a .limit(),
// a .range() page). The two checks are complementary, not contradictory —
// this one governs round-trips per row, that one governs how many rows there
// can be.
//
// Everything else that legitimately needs a query per iteration (a distinct
// external API/resource per item, a parent row whose generated id the next
// insert depends on, etc.) is named in EXCEPTIONS below with a reason —
// additions are a normal review event, not a rubber stamp: the point is that
// every instance is a conscious choice, not silence.
// ============================================================================

const LOOP_OPEN = /(for\s*\(\s*(?:const|let)\s+[\w{}, ]+\s+of\s+|for\s+await\s*\(\s*(?:const|let)\s+[\w{}, ]+\s+of\s+|\.forEach\(|\.map\(\s*async)/g
const QUERY = /\.from\(\s*['"][a-z_]+['"]\s*\)[\s\S]{0,120}?\.(select|insert|update|upsert|delete)\(|\brpc\(/
const STEP_RUN = /step\.run\(/
const STORAGE_UPLOAD = /\.storage\.from\([^)]*\)[\s\S]{0,200}?\.(upload|remove|createSignedUrl)\(/g

function findLoopBody(src: string, matchStart: number, matchEnd: number): string | null {
  // Skip past the loop header's own parens (handles destructured loop vars
  // like `for (const {a, b} of xs) {` without mistaking the destructuring
  // braces for the loop body) before looking for the body's opening '{'.
  let i = matchEnd
  let parenDepth = /for\s*\(|for\s+await\s*\(/.test(src.slice(Math.max(0, matchStart - 1), matchEnd)) ? 1 : 0
  while (i < src.length && parenDepth > 0) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') parenDepth--
    i++
  }
  const openIdx = src.indexOf('{', i)
  if (openIdx === -1) return null
  let depth = 0
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, j + 1)
    }
  }
  return null
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const src = read(file)
    LOOP_OPEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOOP_OPEN.exec(src))) {
      const body = findLoopBody(src, m.index, LOOP_OPEN.lastIndex)
      if (!body) continue
      const bodyNoStorage = body.replace(STORAGE_UPLOAD, '')
      const qm = QUERY.exec(bodyNoStorage)
      if (!qm) continue
      if (STEP_RUN.test(bodyNoStorage.slice(0, qm.index))) continue
      const line = src.slice(0, m.index).split('\n').length
      offenders.push(`${rel(file)}:${line}`)
    }
  }
  return offenders
}

// Verified against the codebase 2026-07-26. Each entry is a real match of
// the pattern above that is NOT a bug — either a bounded/negligible loop, a
// genuinely distinct external resource per iteration, or a parent-row-id
// dependency that forces a per-item insert. Real, fixable N+1s found during
// the same audit were fixed directly rather than allowlisted (see the
// logAuditEvents batching above); everything below was a deliberate,
// reasoned "leave as-is."
const EXCEPTIONS: Record<string, string> = {
  // app/api/account/delete/route.ts no longer needs an entry: the per-org
  // loop bodies now call named helpers (assertSoleMember /
  // cancelOrgSubscriptions / purgeOrganization) rather than inlining queries,
  // and the Stripe-id clear was collapsed from one update per subscription
  // into a single batched patch. Pruned 2026-07-30 with the account-deletion
  // org-orphaning fix.
  'app/(dashboard)/settings/privacy/actions.ts:69':
    'Per-secret delete_vault_secret RPC in the manual Article 17 erasure — the same distinct-external-resource case as the retention cron entry below, and bounded the same way (one BOOKING_BATCH_SIZE page per iteration of the self-draining outer loop, not the guest\'s whole booking history).',
  // ONE entry where there were two: the create-modal path had its own
  // exported copy of this loop in create-work-order-helpers.ts, bypassing
  // sendQuoteRequests' dedup and vendor checks. That copy is deleted and
  // createWorkOrder calls the action.
  'app/(dashboard)/maintenance/actions.ts:499':
    'Per-vendor quote_requests insert (insertQuoteRequests) — each row needs its own randomly generated quote_token before its own Inngest event fires, so batching would mean moving token generation to the caller. Bounded by the vendor count the PM ticked in one dialog, and it is the only RFQ sender in the codebase.',
  'app/(dashboard)/properties/clone-actions.ts:123':
    'Per-section checklist_template_sections insert — each section needs its own DB-generated id before the child checklist_template_items insert can reference it as section_id. Parent-before-child dependency, not a batchable read.',
  'app/api/work-orders/[token]/photos/route.ts:109':
    'Per-photo storage upload + work_order_photos row — each photo is a distinct uploaded file with its own generated storage path; there is no batched form of a storage upload.',
  'app/(dashboard)/maintenance/CreateWorkOrderModal.tsx:202':
    'Same per-photo storage-upload + row pattern, client-side.',
  'lib/asset-discovery/seed-from-amenities.ts:70':
    'Real N+1 (existence-check select + insert per property) left as a known, bounded cost — deferred rather than fixed blind in the same PR that added this guardrail, since it touches live PMS-sync logic. Bounded by properties-per-org (10-50 per CLAUDE.md\'s target user).',
  'lib/asset-discovery/seed-from-amenities.ts:184':
    'Second pass (absent-asset-types) of the same function — same reasoning as line 63.',
  'lib/inngest/functions/guidebook-stay-extension-cron.ts:165':
    'Real N+1 (existence check, next-booking lookup, opt-in lookup, insert — 4 queries per booking) left as a known, bounded cost — deferred rather than fixed blind, touches live guest-messaging sync logic. Bounded by same-day checkouts per org per day, and since the 2026-08-09 fan-out fix it runs inside the per-org handler (guidebookStayExtensionOrg) rather than inside a loop over every org on the platform.',
  'lib/inngest/functions/checklist-broadcast.ts:130':
    'Per-section insert (parent-before-child, same reasoning as clone-actions.ts:122) — additionally guarded by a template-signature equality check just above that skips the whole delete-then-recreate rebuild when nothing changed.',
  'lib/inngest/functions/cron/guest-pii-retention.ts:137':
    'Per-secret delete_vault_secret RPC call — each is a distinct external Vault secret; structurally cannot be batched into one call any more than "one API call per distinct external resource" ever can. Bounded since the 2026-07-30 scalability pass: the loop now iterates one BOOKING_BATCH_SIZE page inside a per-batch step, not an org\'s entire un-anonymized booking history.',
  'lib/inngest/functions/ownerrez/initial-sync.ts:368':
    'Per-property conditional field patch (bedrooms/bathrooms/max_guests/square_footage) — each property\'s patch object contains different values, so it is not a uniform batched update. Pre-fetch of existing rows just above IS already batched via .in(\'external_id\', ids).',
  'lib/guidebook/sync.ts:168':
    'Per-property conditional guidebook-config patch — same shape as ownerrez/initial-sync.ts:368 (differing patch per row); the read side just above is already batched via .in(\'property_id\', ids).',
  'lib/properties/upsert-normalized.ts:337':
    'Per-property conditional cleaning_cost backfill — same differing-patch-per-row shape as the two entries above.',
  'lib/inngest/functions/turnover-events.ts:354':
    'Milestone-flag upserts — the milestones array has at most 3 possible entries (first_turnover_complete/_10/_50) and is almost always exactly 1; negligible enough that batching would add more complexity than it saves.',
  'lib/push/send-push.ts:61':
    'Per-subscription webpush.sendNotification call (+ conditional delete on a 410) — each subscription is a distinct external Web Push endpoint; inherently one call per endpoint, like the Vault-secret case above.',
  'lib/properties/upsert-normalized.ts:310':
    'Per-unique-coordinate-group update on PMS import — the same optimized end state as geocoding-backfill.ts:96, and grouped the same way: one UPDATE per distinct resolved lat/lng, not per property. A portfolio in one market is typically one or two groups.',
  'lib/inngest/functions/geocoding-backfill.ts:96':
    'Per-unique-coordinate-group update — already the optimized end state (grouped from one geocode call per property down to one per distinct resolved lat/lng); a single UPDATE cannot set different coordinate values across differently-grouped id sets without a CASE expression, which is a bigger and less readable change for the same 3-4 typical groups per run.',
  'lib/inngest/functions/geocoding-backfill.ts:150':
    'Vendor twin of geocoding-backfill.ts:96 — same reasoning.',
}

describe('guardrail: no query-per-loop-iteration (N+1) outside named exceptions', () => {
  const offenders = findOffenders()

  it('finds the loop+query pattern population (sanity: the scan is not silently empty)', () => {
    expect(offenders.length).toBeGreaterThan(10)
  })

  it('every match is either fixed or a named, justified exception', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

    expect(
      unlisted,
      [
        'A Supabase query (or RPC call) was found inside a per-row loop body —',
        'this issues one round-trip per row instead of one batched call',
        '(CLAUDE.md: "never issue one query per iteration of a loop").',
        'Either batch it (.in(\'id\', ids), a single upsert(array), etc.), or —',
        'if a genuine per-item necessity — add it to EXCEPTIONS in this test',
        'with a reason. Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which no longer matches the loop+query pattern — remove the stale entry (the code likely moved, was fixed, or was refactored).`
      ).toBe(true)
    }
  })
})
