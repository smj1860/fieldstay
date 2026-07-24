# Business Logic, Algorithms & Technical Debt Audit

## Executive Summary
The financial automation pipelines (cleaning fee, WO completion, PO approval, booking
revenue) are largely correct and properly idempotent thanks to the
`owner_transactions_source_ref_unique (source_reference_id, source)` constraint added in
`20260609000002_idempotency_hardening.sql`. The asset health score and MACRS depreciation
formulas are mathematically sound with reasonable guards against divide-by-zero. The
crew auto-assignment scoring is well-normalized (weights sum to 1.0 in both branches,
workload divisor guarded). The most significant issues found are: (1) a silent fallback
to `estimated_cost` when `actual_cost` is null in the WO-completion expense poster,
contradicting the documented spec; (2) `types/database.ts` drift on `WorkOrder` —
it still defines the deprecated `assigned_crew_id` column instead of
`assigned_crew_member_id`, and `app/(dashboard)/maintenance/page.tsx` actively selects
the non-existent column; (3) `organizations` interface is missing all 5 `repuguard_*`
columns added by the RepuGuard migration despite being read/written by live API routes;
(4) vendor geocoding (`app/(dashboard)/settings/actions.ts`) feeds full street addresses
into `geocodeZip()`, which only supports ZIP-postcode lookups via Mapbox — vendor
`lat`/`lng` silently never populate when `service_zip` is blank, breaking
auto-assignment proximity scoring for those vendors. No `.from('memberships')` bugs were
found, and only one `: any` exists in the entire `app/`+`lib/` tree. Findings:
**0 CRITICAL, 4 HIGH, 1 MEDIUM, 3 LOW** (two of the LOW items are "verified correct,
documented for completeness" notes rather than active bugs — see Findings section).

## Findings

### HIGH — `work_order/completed` posts `estimated_cost` as an expense when `actual_cost` is null
**Status: FIXED** — `lib/inngest/functions/work-order-events.ts:295-317` now
only posts on real `actual_cost` (`const cost = wo?.actual_cost ?? null`), with
a comment noting `logActualCost()` posts/corrects the expense once `actual_cost`
is logged.
- **Area:** Financial Math
- **Location:** `lib/inngest/functions/work-order-events.ts:122-145`
- **Description:**
  ```ts
  const { data: wo } = await supabase
    .from('work_orders')
    .select('title, actual_cost, estimated_cost')
    .eq('id', work_order_id)
    .single()

  const cost = wo?.actual_cost ?? wo?.estimated_cost ?? null
  if (!cost || cost <= 0) return { skipped: true }

  await supabase.from('owner_transactions').upsert({
    ...
    source: 'wo_completion',
    amount: cost,
    ...
  }, { onConflict: 'source_reference_id,source', ignoreDuplicates: true })
  ```
  The CLAUDE.md spec says "Read `work_order.actual_cost`" for this automation, but the
  code falls back to `estimated_cost` whenever `actual_cost` is null. Because this
  handler fires on `work_order/completed`, a WO can be marked completed with
  `actual_cost` never filled in (e.g., vendor portal flow stores notes/photos but PM
  hasn't entered the real invoice amount yet). The result is an owner expense posted
  using the *estimate*, and — critically — because `ignoreDuplicates: true` is set on
  the upsert keyed on `(source_reference_id, source)`, if the PM later updates
  `actual_cost` and any retrigger occurs, the row will NOT be updated/corrected (the
  conflicting row is silently skipped). The estimate becomes permanent.
- **Risk:** Owner P&L can be permanently wrong (either over- or under-stated vs. the real
  invoice), with no automatic correction path once `actual_cost` is filled in later.
- **Recommendation:** Either (a) only post when `actual_cost` is non-null (skip
  otherwise, and trigger the posting from the action that *sets* `actual_cost` instead
  of `wo_status -> completed`), or (b) if the estimate fallback is intentional as a
  placeholder, change `ignoreDuplicates: true` to an `UPDATE` path (or a real `upsert`
  without `ignoreDuplicates`) so a later `actual_cost` correction overwrites the
  placeholder amount.

### HIGH — `handleWorkOrderCompletedViaPortal` can double-post if `wo_status` also transitions to `completed`
- **Area:** Financial Math
- **Location:** `lib/inngest/functions/work-order-events.ts:113-150` and `:154-228`
- **Description:** Two separate Inngest functions can both post `owner_transactions`
  rows for the same work order with `source = 'wo_completion'` and
  `source_reference_id = work_order_id`:
  - `handleWorkOrderCompleted` (triggered by `work-order/completed`) — uses
    `actual_cost ?? estimated_cost`.
  - `handleWorkOrderCompletedViaPortal` (triggered by `work-order/completed-via-portal`)
    — uses `actual_cost` only (no estimated fallback), at line 187-201.

  Both use `upsert(... , { onConflict: 'source_reference_id,source', ignoreDuplicates: true })`.
  The DB unique constraint `(source_reference_id, source)` makes this *safe from
  duplicate rows*, but **the amount that "wins" depends on insertion order** — if the
  portal completion fires first (with the real `actual_cost`, e.g. $250) and then the
  PM-side completion event fires later with a stale `estimated_cost` (e.g. $180), the
  second upsert is silently ignored, so the correct $250 is preserved. But if the order
  is reversed (PM-side fires first using `estimated_cost` $180, before the vendor has
  entered `actual_cost`), the portal completion's accurate $250 row is the one that gets
  silently dropped by `ignoreDuplicates`.
- **Risk:** Race-condition-dependent owner P&L inaccuracy — same WO can yield different
  posted amounts depending on which event fires first, and there is no log/alert when a
  row is dropped.
- **Recommendation:** Pick a single source of truth event for "post WO expense"
  (preferably the one that fires only after `actual_cost` is confirmed), and have the
  other handler simply skip the financial posting entirely (it already has a separate
  `notify-pm-of-completion` responsibility). Alternatively, switch from
  `ignoreDuplicates: true` to an explicit "update only if existing row used an estimate"
  conflict-resolution strategy.

### HIGH — `types/database.ts` `WorkOrder.assigned_crew_id` is the deprecated column; `maintenance/page.tsx` selects it
**Status: FIXED** — `types/database.ts:724` only declares
`assigned_crew_member_id` now; the deprecated `assigned_crew_id` field is gone.
- **Area:** Type Safety
- **Location:** `types/database.ts:478`, `app/(dashboard)/maintenance/page.tsx:23`
- **Description:** CLAUDE.md explicitly states:
  > `assigned_crew_id` on work_orders → `assigned_crew_member_id` (old column deprecated)

  Yet `types/database.ts` line 478 still declares:
  ```ts
  export interface WorkOrder {
    ...
    assigned_crew_id:            string | null   // ← deprecated / does not exist
    ...
  }
  ```
  And `app/(dashboard)/maintenance/page.tsx:23` actively does:
  ```ts
  .from('work_orders')
  .select(`
    id, property_id, vendor_id, assigned_crew_id,
    wo_number, title, description, category, priority, status, source,
    ...
  `)
  ```
  Meanwhile `app/(dashboard)/maintenance/actions.ts` and
  `app/(dashboard)/maintenance/[id]/page.tsx` correctly use
  `assigned_crew_member_id`. The interface having both an obsolete field present (and
  the correct field — verify it's also declared) means the Supabase client's generated
  return type for this select string type-checks even though `assigned_crew_id` is not
  a real column.
- **Risk:** At runtime, `select('...assigned_crew_id...')` against a table without that
  column returns a Postgres "column does not exist" error (500) for the maintenance
  list page — or, if the column actually still exists as legacy cruft, the maintenance
  board displays stale/incorrect crew assignment data sourced from a column the rest of
  the app no longer writes to.
- **Recommendation:** Confirm via `list_tables`/migration history whether
  `work_orders.assigned_crew_id` physically exists. If not, remove it from
  `types/database.ts` and fix `maintenance/page.tsx:23` to select
  `assigned_crew_member_id` (and update any rendering code in `maintenance-board.tsx`
  /`maintenance/page.tsx` that reads `.assigned_crew_id`). If the column does exist as
  legacy data, add a migration to drop it and do the same code fix.

### HIGH — `organizations` interface missing all RepuGuard columns; live API routes read/write them
**Status: FIXED** — `types/database.ts:115-119` now has all five `repuguard_*`
fields (with `repuguard_status` as the recommended narrow union type).
- **Area:** Type Safety
- **Location:** `types/database.ts:84-103` (Organization interface) vs.
  `supabase/migrations/20260601000000_repuguard.sql`
- **Description:** The migration adds:
  ```sql
  ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS repuguard_status                 text DEFAULT 'inactive'
    ADD COLUMN IF NOT EXISTS repuguard_trial_start            timestamptz,
    ADD COLUMN IF NOT EXISTS repuguard_trial_end              timestamptz,
    ADD COLUMN IF NOT EXISTS repuguard_stripe_subscription_id text,
    ADD COLUMN IF NOT EXISTS repuguard_founding_member        boolean NOT NULL DEFAULT false;
  ```
  None of these five columns appear in `export interface Organization` in
  `types/database.ts:84-103`. Yet they are actively used:
  - `app/api/repuguard/activate/route.ts:48,56,79` — `.select('repuguard_status')`,
    reads `org.repuguard_status`, `.update({ repuguard_status: 'active' })`
  - `app/api/webhooks/stripe/route.ts:75-83,144-149` — `.update({ repuguard_status: ... })`
  - `app/(dashboard)/reviews/page.tsx`, `reviews-client.tsx`, `app/(dashboard)/layout.tsx`
    likely read trial/founding-member flags for gating UI.
- **Risk:** Per CLAUDE.md's own "most important housekeeping rule" — the Supabase TS
  client infers types from `types/database.ts`, not the live schema. Any `.select()`
  or `.update()` touching these columns either falls back to loosely-typed results
  (defeats strict null checks) or fails to compile depending on how the client/select
  string is typed. At minimum, `org.repuguard_status` accesses are not type-checked
  against the real nullable/default semantics (e.g. `text DEFAULT 'inactive'`, not
  necessarily one of a known enum of values).
- **Recommendation:** Add to `Organization` interface:
  ```ts
  repuguard_status:                   string             // default 'inactive'
  repuguard_trial_start:              string | null
  repuguard_trial_end:                string | null
  repuguard_stripe_subscription_id:   string | null
  repuguard_founding_member:          boolean
  ```
  Consider a `RepuguardStatus` union type if the route code only ever sets/compares a
  fixed set of values (`'inactive' | 'active' | 'cancelled' | ...` — verify all values
  used in `stripe/route.ts` and `repuguard/activate/route.ts`).

### MEDIUM — Vendor geocoding feeds full street address into a ZIP-only Mapbox endpoint
- **Area:** Code Duplication / Geocoding
- **Location:** `app/(dashboard)/settings/actions.ts:302-309, 360-375` vs.
  `lib/geocoding.ts:18-27`
- **Description:** `lib/geocoding.ts` `geocodeZip()` is hardcoded to Mapbox's
  `types=postcode` endpoint:
  ```ts
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(zip)}.json?country=US&types=postcode&limit=1&access_token=${token}`
  ```
  This works correctly for `properties/actions.ts` (always passes a real ZIP, e.g.
  `geocodeZip(zip)` at lines 88 and 158). But `settings/actions.ts` (vendor
  create/update — added alongside the `20260609000008` migration that introduced
  `vendors.address/city/state` "for more precise geocoding (full address vs zip-only)")
  does:
  ```ts
  // createVendor (~line 302-309)
  const geocodeInput = [address, city, state, service_zip].filter(Boolean).join(', ')
  if (geocodeInput) {
    const coords = await geocodeZip(service_zip ?? geocodeInput)   // <- full address string passed when no zip
    ...
  }

  // updateVendor (~line 360-375)
  const geocodeInput = service_zip ?? [address, city, state].filter(Boolean).join(', ')
  if (geocodeInput) {
    const coords = await geocodeZip(geocodeInput)                  // <- same issue
    ...
  }
  ```
  When `service_zip` is empty/null but `address`/`city`/`state` are filled, a string
  like `"123 Main St, Austin, TX"` is passed to a `types=postcode` Mapbox query, which
  will return zero results (postcodes endpoint does not match street addresses).
  `coords` will be `null` and `vendors.lat`/`vendors.lng` are never set.
- **Risk:** Vendors entered with a full address but no ZIP never get `lat`/`lng`
  populated. `lib/inngest/functions/auto-assign-turnover.ts` and any vendor-distance
  features (`vendors.service_radius_miles`) silently degrade — those vendors are
  treated as having no location (`proximity = 0.5` default in auto-assign, or excluded
  entirely from radius-based vendor matching).
- **Recommendation:** Either (a) require `service_zip` for vendors and validate it in
  the form, or (b) add a second function to `lib/geocoding.ts`,
  e.g. `geocodeAddress(address, city, state)`, using Mapbox's general
  `mapbox.places/{query}.json` endpoint (no `types=postcode` filter) and have
  `settings/actions.ts` call that when `service_zip` is absent.

### LOW — `record-crew-duration` anomaly cutoff is a magic number with no per-property tuning
- **Area:** Crew Scoring / learning loop
- **Location:** `lib/inngest/functions/turnover-events.ts:289-294`
- **Description:** `durationMinutes > 480` (8 hours) is hardcoded as the anomaly
  threshold for skipping `assignment_outcomes.duration_minutes` updates. For very large
  properties (e.g., 6BR+ with `square_footage` now tracked per CLAUDE.md Step 2), 8 hours
  may be a legitimate turnover duration, silently excluding good training data from the
  learning loop.
- **Risk:** Learning-loop data sparsity for large properties; not a correctness bug, but
  worth flagging since `assignment_outcomes` feeds the auto-assignment scoring.
- **Recommendation:** Scale the threshold by `property.square_footage` or
  `property.bedrooms`, or make it an org-level setting.

### LOW — Asset health `recencyBonus` can reward an asset with zero repair history equally to one recently serviced
- **Area:** Asset Health
- **Location:** `lib/assets/health-score.ts:35-41`
- **Description:**
  ```ts
  const monthsSinceService = repairHistory.last_serviced_at
    ? Math.floor((Date.now() - new Date(repairHistory.last_serviced_at).getTime()) / (1000*60*60*24*30))
    : 999
  const recencyBonus = monthsSinceService < 6 ? 5 : monthsSinceService < 12 ? 2 : 0
  ```
  When `last_serviced_at` is `null` (never repaired), `monthsSinceService = 999`, so
  `recencyBonus = 0`. This is correct — an asset that's never been serviced gets no
  recency bonus. No bug here, but worth noting the 30-day month approximation
  (`/30`) creates slight drift vs. calendar months — immaterial for a 6/12 month
  threshold check. **Not flagged as an issue**, included for completeness — verified
  correct.

### LOW — `getMacrsRate` final-year "true-up" relies on `MACRS_RATES` table summing to ~1.0
- **Area:** Asset Health/Depreciation
- **Location:** `lib/assets/depreciation.ts:5-13, 23-26`
- **Description:** The 15-year table sums to `0.9996` (not exactly `1.0`) due to
  rounding in the published IRS Table A-1 150% DB rates. The final-year logic
  (`yearOfService === rates.length`) computes `1 - priorSum` to true-up to exactly
  100% recovery — for the 15-year table this means year 16 absorbs an extra `0.0004`
  (0.04%) of cost basis vs. the published per-year rate. This is the IRS-correct
  approach (the official tables are themselves rounded and the final year is meant to
  absorb the remainder), so this is **working as intended**, not a bug. Documented here
  for audit completeness.

## Code Duplication Map

| Pattern | Locations (file:line) | Suggested shared location |
|---|---|---|
| `requireOrgMember()` → try/catch → `{ success, error }` action-result wrapper. 22 `actions.ts` files implement this independently; `messages/actions.ts` alone repeats the literal `{ success: false, error: ... }` shape 13×. | `app/(dashboard)/messages/actions.ts` (13 occurrences), plus 1 each in most of the other 21 `actions.ts` files (e.g. `app/(dashboard)/inventory/actions.ts`, `app/(dashboard)/turnovers/actions.ts`, `app/(dashboard)/maintenance/actions.ts`) | `lib/actions/with-org-action.ts` — a `withOrgAction(handler)` wrapper or `runOrgAction()` helper that does `requireOrgMember()` + try/catch + standard `ActionResult<T>` return, per the "Error Handling in Server Actions" pattern already documented in CLAUDE.md but not centralized. |
| `owner_transactions` idempotent insert/upsert for financial postings — three subtly different conflict-handling strategies for the *same* `(source_reference_id, source)` pair: plain `insert()` after `maybeSingle()` pre-check (cleaning fee, PO), `upsert(..., { ignoreDuplicates: true })` (Inngest WO completion ×2), and `upsert(..., onConflict)` with no `ignoreDuplicates` — i.e. an actual update-on-conflict (server action WO actual-cost entry). | `lib/inngest/functions/turnover-events.ts:218-263` (cleaning fee, pre-check+insert) · `lib/inngest/functions/inventory-events.ts:20-43` (PO approved, pre-check+insert) · `lib/inngest/functions/work-order-events.ts:131-145` and `:189-201` (`ignoreDuplicates: true`) · `app/(dashboard)/maintenance/actions.ts:426-437` (upsert, updates amount) · `lib/inngest/functions/booking-events.ts:19-26,51-62` and `:148-178` (pre-check+insert) | `lib/finance/post-owner-transaction.ts` — a single `postOwnerTransaction({ source, sourceReferenceId, ... })` helper that always does pre-check-then-insert (or a single documented upsert strategy), so all 6 call sites behave identically and the WO-completion "estimate vs actual" overwrite question (HIGH finding above) is decided in one place. |
| Geocode-on-save logic — properties implement it correctly (zip-only, `lib/geocoding.ts`); vendors implement a parallel/incompatible variant in a different file. | `app/(dashboard)/properties/actions.ts:87-93,157-163` (correct, zip-only) vs. `app/(dashboard)/settings/actions.ts:302-309,360-375` (vendor — broken full-address fallback, see MEDIUM finding) | `lib/geocoding.ts` — add `geocodeAddress()` for full-address lookups and a single `geocodeOnSave(entity, { zip, address, city, state })` helper used by both `properties/actions.ts` and `settings/actions.ts`. |
| "Re-geocode only if address-related fields changed" diffing logic — implemented ad hoc per entity. | `app/(dashboard)/properties/actions.ts:157` (`zip !== existing?.zip`) vs. `app/(dashboard)/settings/actions.ts:361-365` (4-field comparison: `service_zip`, `address`, `city`, `state`) | Same `lib/geocoding.ts` helper as above — accept the previous + new address fields and internally decide whether to re-geocode. |
| CSV bulk-import row mapping/validation — each module reimplements "map raw CSV rows → typed insert payload, validate required fields, batch insert". | `app/(dashboard)/inventory/actions.ts:388-` (`bulkAddTemplateItemsFromCSV`) · `app/(dashboard)/properties/actions.ts:400-` (`CsvAssetRow` / bulk asset import) | `lib/csv/bulk-import.ts` — generic `parseAndInsertCsvRows<T>(rows, validator, mapper, insertFn)` helper; at minimum share the row-validation/error-collection shape. |
| Milestone upsert (`org_milestones`, `onConflict: 'org_id,milestone', ignoreDuplicates: true`) — repeated verbatim across Inngest functions for different milestone keys. | `lib/inngest/functions/turnover-events.ts:208-212` · `lib/inngest/functions/inventory-events.ts:165-168` · `lib/inngest/functions/build-shopping-cart.ts:85-88` · `lib/inngest/functions/cron/asset-health.ts:230-233` (insert, not upsert, for compliance dedup) | `lib/inngest/helpers.ts` (already exists, has `getPmEmail`) — add `recordMilestoneOnce(supabase, orgId, milestoneKey, value?)`. |

## types/database.ts Drift

| Table | Migration column | types/database.ts status | Notes |
|---|---|---|---|
| `organizations` | `repuguard_status text DEFAULT 'inactive'`, `repuguard_trial_start timestamptz`, `repuguard_trial_end timestamptz`, `repuguard_stripe_subscription_id text`, `repuguard_founding_member boolean NOT NULL DEFAULT false` (`20260601000000_repuguard.sql`) | **Missing entirely** — none of the 5 columns appear in `Organization` interface (`types/database.ts:84-103`) | Read/written by `app/api/repuguard/activate/route.ts`, `app/api/webhooks/stripe/route.ts`, `app/(dashboard)/reviews/*`, `app/(dashboard)/layout.tsx`. See HIGH finding above. |
| `organization_members` | `role text NOT NULL DEFAULT 'admin'` (`20260601000000_repuguard.sql`, also redefined later as `MemberRole` enum) | Present as `role: MemberRole` (`types/database.ts:109`) — **OK**, enum-typed, consistent with later migrations that constrain `role` to the `member_role` enum. | No drift; the `text NOT NULL DEFAULT 'admin'` migration appears superseded by the enum constraint. Confirm the enum migration ran after this one (ordering looks correct: `20260601` → `20260602_team_access` likely adds the enum constraint). |
| `owner_transactions` | `source text`, `source_reference_id text`, `visible_to_owner boolean NOT NULL DEFAULT true` (`20260608200000_security_idempotency_hardening.sql`) + `UNIQUE (source_reference_id, source)` (`20260609000002`) | Present: `source: string | null`, `source_reference_id: string | null`, `visible_to_owner: boolean` (`types/database.ts:615-617`) — **OK** | Correct nullability matches `text` (nullable) columns and `NOT NULL DEFAULT true` for `visible_to_owner`. |
| `properties` | `cleaning_cost_visible_to_owner boolean NOT NULL DEFAULT true` (`20260608200000_security_idempotency_hardening.sql`) | Present: `cleaning_cost_visible_to_owner: boolean` (`types/database.ts:142`) — **OK** | Matches `NOT NULL DEFAULT true`. `cleaning_cost` and `same_day_premium_pct` (lines 140-141) also present and nullable, matching turnover-events.ts usage. |
| `work_orders` | `category wo_category` (`20260608200000_security_idempotency_hardening.sql`); `source_turnover_id UUID REFERENCES turnovers(id)` (`20260609000002_idempotency_hardening.sql`) | `category: WoCategory | null` present (`types/database.ts:482`) — OK. `source_turnover_id: string | null` present (`types/database.ts:487`) — OK. **BUT** `assigned_crew_id: string | null` (line 478) is the deprecated/nonexistent column — see HIGH finding. | `category` and `source_turnover_id` are in sync; `assigned_crew_id` is stale drift in the opposite direction (type exists for a column that's deprecated/possibly dropped). |
| `owner_portal_tokens` | `revoked_at timestamptz` (`20260609000002_idempotency_hardening.sql`); `UNIQUE (property_owner_id, is_multi)` constraint added same migration | `revoked_at: string | null` present (`types/database.ts:171`) — **OK** | In sync. |
| `vendors` | `address text`, `city text`, `state text` (`20260609000008_grant_missing_tables_vendor_address.sql`) | All three present and nullable (`types/database.ts:257-259`), alongside pre-existing `lat`/`lng`/`service_zip`/`service_radius_miles` — **OK** | Type-level drift is clean here; the bug is functional (geocoding never populates `lat`/`lng` for address-only vendors — see MEDIUM finding above), not a `types/database.ts` issue. |

## `any` / unguarded `unknown` Inventory

| File:Line | Context |
|---|---|
| `lib/inngest/functions/build-shopping-cart.ts:193` | `const uniqueNames = [...new Set(belowParItems.map((i: any) => i.name.toLowerCase().trim()))]` — the only `: any` found in `app/` + `lib/`. Root cause: `belowParItems` is returned from a `step.run(...)` block (Inngest step results lose precise inference across the boundary in this codebase's setup), so the array element type degrades. **Fix:** declare an explicit `BelowParItem` interface (matching the `inventory_items` select shape: `id, name, current_quantity, par_level, unit, preferred_brand, property_id, properties`) and annotate the `step.run` return type, or cast the step result once to `BelowParItem[]` instead of using `any` per-callback. |
| All other `unknown` usages (`app/(dashboard)/turnovers/actions.ts:81,111,317-318`, `app/(dashboard)/maintenance/actions.ts:305`, `app/(dashboard)/inventory/actions.ts:511`, `app/(dashboard)/properties/[id]/setup/checklist/checklist-builder.tsx:153`, `app/(dashboard)/properties/[id]/setup/inventory/inventory-setup.tsx:76`, `lib/integrations/**`, `lib/audit.ts:54`, `app/api/webhooks/[provider]/route.ts:66`) | All are either (a) `Record<string, unknown>` for genuinely-dynamic JSON metadata/payload fields (audit metadata, integration payloads — appropriate use), or (b) immediately narrowed via `as unknown as <ConcreteType>` / `instanceof` / property-existence checks before use (e.g. `(props as unknown as { name?: string } | null)?.name`). No unguarded-`unknown`-then-property-access patterns found. **No action needed** — flagged here for completeness per the audit brief. |

Overall `any`/`unknown` hygiene is good — this is **not** a significant area of technical debt compared to the duplication and type-drift findings above.
