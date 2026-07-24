# PowerSync, Local-First Sync & Scalability Audit

> **OBSOLETE — this audit covers `lib/powersync/*`, which has been fully removed and replaced by the Dexie/IndexedDB local-first sync layer (see CLAUDE.md). Every finding below refers to deleted code, not merely superseded code.**

## Executive Summary

FieldStay has no version-controlled PowerSync sync-rule definitions anywhere in
the repo, and the `lib/powersync/schema.ts` client schema omits `org_id` from
several tables (`properties`, `checklist_instances`, `inventory_items`),
making safe per-tenant sync filtering harder to verify and easy to get wrong.
The most severe issue is a **local-first consistency break**: the crew PWA's
"Mark as Complete" action writes directly to PowerSync/SQLite and never fires
the `turnover/completed` Inngest event that the dashboard's equivalent Server
Action uses to post cleaning-fee expenses, notify the PM, and record crew
duration — meaning the core financial-automation promise silently does not
fire for the majority of real-world turnover completions (which happen via the
crew app, not the dashboard). Additionally, two daily cron jobs
(`cron/maintenance-schedules.ts`, `cron/work-order-ops.ts`,
`cron/asset-health.ts`) call a 2-query-per-call `getPmEmail()` helper inside
per-item loops despite an existing batched `getPmEmailsByOrgIds()` helper that
is unused — at scale this is hundreds of extra sequential round trips per run.
No tenant-leakage caching issues were found (the app uses no `revalidate`,
`unstable_cache`, or `force-cache` anywhere).

**Findings by severity:** 1 Critical, 4 High, 5 Medium, 3 Low (13 total).

---

## Findings

### CRITICAL: Crew "Mark Complete" bypasses the entire turnover-completion automation pipeline
- **Area:** Local-First Consistency
- **Location:** `app/crew/turnovers/[id]/page.tsx:148-158` (`markComplete`), vs. `app/(dashboard)/turnovers/actions.ts:104-160` (`updateTurnoverStatus`)
- **Description:** When a PM marks a turnover complete from the dashboard, `updateTurnoverStatus()` (1) sets `status='completed'`, `completed_at`, `completion_notes`, and (2) sends the `turnover/completed` Inngest event, which triggers `handleTurnoverCompleted` (`lib/inngest/functions/turnover-events.ts:158-307`) — posting the cleaning-fee `owner_transactions` row, notifying the PM by email, recording crew-duration `assignment_outcomes`, and bumping `org_milestones`.

  The crew PWA's `markComplete()` instead does only:
  ```ts
  await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['completed', id])
  ```
  This is a raw local PowerSync write. It (a) never sets `completed_at` or `completion_notes`, and (b) — because `SupabaseConnector.uploadData()` in `lib/powersync/client.ts:22-45` only handles `op.table === 'turnovers'` by updating `status` — never triggers any server-side Inngest event. There is no Server Action call anywhere in `app/crew/**` that sends `'turnover/completed'`.
- **Risk:** The crew app is the primary way turnovers get marked complete in production (crew on-site, not PMs at a desk). For every turnover completed via the crew PWA: no cleaning-fee expense is posted to `owner_transactions` (breaking owner P&L and the "automation removes cognitive overhead" promise), no PM completion email is sent, `assignment_outcomes.duration_minutes` is never recorded (breaking the auto-assignment learning loop), and `completed_at`/`completion_notes` remain null forever. PowerSync will faithfully sync `status='completed'` down to all clients, so the UI *looks* correct while the entire downstream automation silently never runs.
- **Recommendation:** Do not allow `turnovers.status` to be mutated to `'completed'` via a raw PowerSync CRUD upload. In `SupabaseConnector.uploadData()`, special-case the `turnovers` PUT-to-`completed` transition: either (a) call a Server Action / RPC (e.g. a Postgres function `complete_turnover(turnover_id)`) that performs the same update + sets `completed_at`/`completion_notes` + sends `turnover/completed` atomically, or (b) have the local `markComplete()` call a new `app/crew/turnovers/actions.ts` Server Action (`completeTurnover(id, notes)`) that mirrors `updateTurnoverStatus`'s logic and event dispatch, then let PowerSync sync the resulting row back down. The same gap applies to `markInProgress()` (line 144-146) which also skips setting `started_at`.

---

### HIGH: Crew PWA writes `work_orders` directly via client-side Supabase, bypassing Server Actions and tenant-scoping conventions
- **Area:** Local-First Consistency
- **Location:** `app/crew/turnovers/[id]/page.tsx:509-517` (`IssueReportModal.handleSubmit`)
- **Description:** The "Report an Issue" modal calls `supabase.from('work_orders').insert({...org_id: turnover.org_id...})` directly from a `'use client'` component using `createClient()` (browser Supabase client), not a Server Action and not a PowerSync write. This both violates the documented local-first pattern ("client components must NEVER call Supabase directly for reads" — and here it's a write that bypasses the audited Server Action path) and trusts a client-supplied `turnover.org_id` value (sourced from the local PowerSync `turnovers` row) for an INSERT, relying entirely on RLS INSERT policies to be airtight.
- **Risk:** If RLS `work_orders` INSERT policy is ever loosened or has a gap, a compromised/tampered client could insert work orders into another org by spoofing `org_id` (PowerSync local DB is client-controlled storage). Even with correct RLS, this path is invisible to the `work_order/created` Inngest pipeline unless that pipeline is driven by DB triggers — confirm whether `wo_source = 'crew_flag'` work orders trigger `handleWorkOrderCreated`.
- **Recommendation:** Replace this with a Server Action (e.g. `app/crew/turnovers/actions.ts: reportIssue()`) that calls `requireOrgMember()`-equivalent crew auth (mirroring `requireCrewMember()` in `app/crew/availability/actions.ts:13-26`), derives `org_id` server-side from the authenticated crew member's row (never trusting the client value), inserts the work order, and fires `work_order/created` if applicable.

---

### HIGH: `getPmEmail()` called per-item inside cron loops despite an existing batched alternative
- **Area:** N+1 Query
- **Location:**
  - `lib/inngest/functions/cron/maintenance-schedules.ts:67` (inside `for (const schedule of dueSchedules)`, line 59)
  - `lib/inngest/functions/cron/maintenance-schedules.ts:192` (inside `for (const schedule of overdueSchedules)`, line 175)
  - `lib/inngest/functions/cron/work-order-ops.ts:73` (inside `for (const wo of agingWOs)`, line 44)
  - `lib/inngest/functions/cron/work-order-ops.ts:139` (inside `for (const group of repeatGroups)`, line 116)
  - `lib/inngest/functions/cron/work-order-ops.ts:259` (inside `for (const schedule of autoWOSchedules)`, line 186)
  - `lib/inngest/functions/cron/asset-health.ts:139` (once per org with crossings — lower impact)
- **Description:** `getPmEmail()` (`lib/inngest/helpers.ts:11-28`) does two sequential round trips per call: a `organization_members` SELECT filtered by `org_id` + role, then `supabase.auth.admin.getUserById()`. It is called once per loop iteration in five separate hot paths across the two daily crons, even though many iterations share the same `org_id` (e.g. multiple overdue schedules for the same org). A batched helper `getPmEmailsByOrgIds()` already exists at `lib/inngest/helpers.ts:35-66` and returns a `Map<orgId, email>` with `Promise.all` — but it is **not used anywhere** (only referenced in its own file).
- **Risk:** At 50 orgs each with, say, 10 due/overdue maintenance schedules and 5 aging work orders, that's up to `(10+10+5+repeatGroups+autoWO) × 50` ≈ 1,000+ extra `organization_members` queries + 1,000+ `auth.admin.getUserById` calls per single daily cron run, each as its own network round trip inside `step.run`. This multiplies Inngest step count, run duration, and the chance of hitting Supabase Auth Admin rate limits.
- **Recommendation:** At the top of each cron, after fetching the due/overdue/aging item lists, collect the distinct `org_id`s and call `getPmEmailsByOrgIds(supabase, orgIds)` once to build a `Map`. Replace each per-item `await getPmEmail(supabase, schedule.org_id)` with a `pmEmails.get(schedule.org_id)` lookup.

---

### HIGH: Per-asset sequential UPDATE inside daily asset-health cron
- **Area:** N+1 Query
- **Location:** `lib/inngest/functions/cron/asset-health.ts:113-119` (inside nested loops at lines 90 and 95)
- **Description:** For every active `property_assets` row across ALL orgs, the cron computes a new `health_score` and issues an individual `await supabase.from('property_assets').update({...}).eq('id', asset.id)` inside a `step.run(\`score-org-assets-${orgId}\`, ...)`.
- **Risk:** At 50 orgs × 30 properties × ~5 trackable assets (HVAC, water heater, roof, appliances, etc.) ≈ 7,500 active assets, this is up to 7,500 sequential UPDATE statements executed inside a single Inngest step per org (so retries re-run the whole per-org batch). This is the largest raw query-count finding in the codebase and runs daily.
- **Recommendation:** Batch the updates. Options: (a) build an array of `{id, health_score, health_score_updated_at}` per org and use `upsert()` with `onConflict: 'id'` in one call per org (single round trip instead of N), or (b) use a Postgres function/RPC that accepts a JSON array of `(id, score)` pairs and does a single `UPDATE ... FROM (VALUES ...)` statement. Either reduces ~7,500 queries/day to ~50 (one per org) or 1 (single RPC for all orgs).

---

### HIGH: No version-controlled PowerSync sync rules anywhere in the repo
- **Area:** Sync Rules
- **Location:** repo-wide (searched for `sync_rules.yaml`, `.powersync/`, any YAML config — none found except `.github/dependabot.yml`)
- **Description:** PowerSync sync rules — the config that determines which rows from which tables sync down to which authenticated user/org — are not present in this repository in any form. They presumably live only in the PowerSync Cloud dashboard for the project (referenced via `NEXT_PUBLIC_POWERSYNC_URL` in `lib/powersync/client.ts:13`).
- **Risk:** There is no code-reviewable, diffable record of the tenant-isolation logic that determines what data syncs to a crew member's device. A misconfiguration in the dashboard (e.g. a bucket definition that syncs `turnovers` by `user_id` membership without also constraining by `org_id`, or a debug "sync everything" bucket left enabled) would not be caught by code review, CI, or this audit, and would silently leak cross-tenant data to crew devices' local SQLite (which then renders directly via `usePowerSyncQuery`, with no further server-side filter). This is the single highest-leverage tenant-isolation control in the local-first architecture and it is entirely outside version control.
- **Recommendation:** Export the current sync rules from the PowerSync dashboard and commit them as `sync_rules.yaml` (or equivalent) in the repo, with a CI check or PR template reminder that schema changes to `lib/powersync/schema.ts` must have a corresponding sync-rule update. At minimum, document in `lib/powersync/README.md` (or `CLAUDE.md`) exactly which buckets exist and how each is parameterized by `org_id`/`crew_member_id`/`user_id`, so future column additions to the PowerSync schema are reviewed against the (now-undocumented) bucket definitions.

---

### MEDIUM: PowerSync `properties` table has no `org_id`, preventing direct tenant-filtered sync rules
- **Area:** Sync Rules
- **Location:** `lib/powersync/schema.ts:40-45`
- **Description:** The synced `properties` table only exposes `name, address, city, state` — no `id`'s sibling `org_id` (the DB-level `Property` interface in `types/database.ts:116-148` does have `org_id: string`). Without `org_id` on the synced row, a PowerSync sync rule bucket cannot do a simple `WHERE org_id IN (user's orgs)` filter on `properties` directly; it would need a parameter query that joins `properties.id` against another org-scoped table (e.g. `turnovers.property_id`) to determine sync membership, which is more complex and easier to get subtly wrong (e.g. a property with no turnovers yet might not sync, or might sync to the wrong tenant if the join condition is loose).
- **Risk:** Either (a) sync rules currently filter `properties` via a join to `turnovers`/`crew_availability` etc. (works but fragile and undocumented — see Finding above), or (b) `properties` is synced without a tenant filter at all, meaning every authenticated crew user's device receives property records (name/address/city/state) for ALL organizations on the platform, not just their own. Given `properties.address` and `door_code`/`wifi_password` are NOT in the synced schema (good), the blast radius of (b) is limited to name/city/state, but it is still a cross-tenant data leak.
- **Recommendation:** Add `org_id: column.text` to the `properties` table in `lib/powersync/schema.ts` and ensure the corresponding sync rule bucket filters `properties` by `org_id IN (SELECT org_id FROM organization_members WHERE user_id = token_parameters.user_id)` directly, matching the pattern presumably used for `turnovers` and `crew_availability` (which already have `org_id`).

---

### MEDIUM: PowerSync `checklist_instances` table has no `org_id`
- **Area:** Sync Rules
- **Location:** `lib/powersync/schema.ts:14-17`
- **Description:** `checklist_instances` is synced with only `turnover_id, status` — no `org_id`, even though the DB-level `ChecklistInstance` interface (`types/database.ts:333-344`) has `org_id: string`. Same class of issue as `properties`: tenant-filtering for this table must be done via a join to `turnovers.org_id` (which does have `org_id` in the synced schema), which is workable but again undocumented since no sync rules file exists.
- **Risk:** Lower than `properties` since the data exposed (`status` of a checklist instance) is low-sensitivity, but still represents a table that can't be independently verified as tenant-filtered without the (missing) sync rules.
- **Recommendation:** Add `org_id: column.text` to `checklist_instances` in the PowerSync schema for defense-in-depth and to allow simpler, independent bucket filtering without relying on a join through `turnovers`.

---

### MEDIUM: PowerSync `inventory_items` table has no `org_id`
- **Area:** Sync Rules
- **Location:** `lib/powersync/schema.ts:31-38`
- **Description:** `inventory_items` is synced with `property_id, name, category, unit, par_level, current_quantity` — no `org_id`, though `InventoryItem` (`types/database.ts:373-389`) has `org_id: string`. Tenant filtering must rely on a join through `properties.org_id` — but as noted above, `properties` itself doesn't carry `org_id` in the synced schema either, so a chained join (`inventory_items.property_id` → `properties.id` → ??? → `org_id`) has no terminal `org_id` column to filter on within the synced schema itself (sync rules CAN reference source-DB columns not in the client schema, but this increases the chance of the sync rule and client schema drifting silently).
- **Risk:** Same class as above — inventory item names/quantities/par levels potentially syncable across tenants if the bucket definition's join logic has any gap, with no version-controlled sync rules to verify against.
- **Recommendation:** Add `org_id: column.text` to `inventory_items` in the PowerSync schema, matching the DB column, for direct filterability.

---

### MEDIUM: `app/crew/turnovers/[id]/page.tsx` inventory count update is a single optimistic local write with no corresponding server reconciliation step
- **Area:** Local-First Consistency
- **Location:** `app/crew/turnovers/[id]/page.tsx:132-139` (`handleCountChange`)
- **Description:** `handleCountChange` does `db.execute('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [qty, itemId])` directly, which `SupabaseConnector.uploadData()` (`lib/powersync/client.ts:39-44`) syncs up as a plain `current_quantity` update. This is a single-table write so it's internally atomic, but it bypasses `app/api/crew/inventory-count/route.ts`'s `submitAsDraft` flow (which creates `inventory_count_drafts`/`inventory_count_draft_items` for PM review) entirely — there are now two divergent code paths for crew-submitted inventory counts: (1) the in-turnover quick-adjust via raw PowerSync write (commits immediately, no PM review, no audit trail), and (2) the dedicated `/crew/inventory/[propertyId]` page which submits a draft for review.
- **Risk:** Inconsistent UX/data-governance: a crew member adjusting counts mid-turnover changes `current_quantity` immediately and silently (no `inventory_count` record, no `inventory/count-submitted` Inngest event, so no automatic low-stock/Kroger-cart trigger from `lib/inngest/functions/inventory-events.ts` fires from this path), while the same crew member using the dedicated inventory page goes through a review queue. PMs may be confused why some inventory changes show up as drafts and others don't, and below-par inventory adjusted via the turnover page won't trigger the "Kroger cart builds itself" automation described in `CLAUDE.md`.
- **Recommendation:** Decide on one canonical path. Either (a) route the turnover-page count changes through the same draft/review flow (requires a Server Action, not a raw PowerSync write), or (b) if immediate commits are intentional for in-turnover counts, ensure the `uploadData()` handler (or a DB trigger) also fires `inventory/count-submitted` / low-stock checks so the Kroger automation still triggers.

---

### MEDIUM: `crew_availability` PowerSync table allows arbitrary local writes with no `uploadData()` handler
- **Area:** Local-First Consistency
- **Location:** `lib/powersync/schema.ts:47-53` (table defined) vs `lib/powersync/client.ts:22-45` (`uploadData`)
- **Description:** `crew_availability` is included in the PowerSync `AppSchema`, but `SupabaseConnector.uploadData()` only special-cases `checklist_instance_items`, `turnovers`, and `inventory_items`. If any code path ever performs a local `db.execute()` write to `crew_availability` (currently the actual mutation path is the Server Action `setCrewAvailability` in `app/crew/availability/actions.ts`, which is correct), that CRUD op would be silently dropped — `transaction.complete()` is called unconditionally at line 46 regardless of whether each `op` matched a handled case, so an unhandled table/op is acknowledged as synced but never written to Supabase.
- **Risk:** Currently low because `app/crew/availability/page.tsx` correctly uses Server Actions (`getMyAvailability`/`setCrewAvailability`) rather than `db.execute()`. But this is a latent footgun: the schema declares `crew_availability` and `messages` and `properties` as locally-writable-shaped tables (PowerSync tables are read/write by default unless restricted), yet `uploadData()` silently no-ops for any write to them. A future developer adding a quick local-write "optimistic toggle" for availability (following the exact pattern already used for `inventory_items`/`checklist_instance_items`/`turnovers` in the turnover page) would produce writes that vanish without error.
- **Recommendation:** Either mark read-only tables as such (PowerSync supports view-only/read-only tables via schema configuration) for `crew_availability`, `messages`, and `properties` so accidental local writes fail loudly/are rejected client-side, or add explicit handlers (or an explicit `else { logger.warn(...) }` / `throw`) in `uploadData()` for any unrecognized `(table, op)` combination so silent data loss can't occur.

---

### LOW: `geocoding-backfill.ts` issues one external API call + one UPDATE per property/vendor sequentially
- **Area:** N+1 Query
- **Location:** `lib/inngest/functions/geocoding-backfill.ts:42-56` (properties), `:75-` (vendors)
- **Description:** For each property/vendor missing `lat`/`lng`, the function calls `geocodeZip()` (external Mapbox HTTP call) then a per-row `.update({lat, lng}).eq('id', ...)`, with a `200ms` `sleep` between each — by design, to respect Mapbox rate limits.
- **Risk:** This is a one-time/manual-trigger backfill (`event: 'geocoding/backfill-requested'`), not a recurring cron, so the N+1 pattern is bounded and intentional for the external API. However, the per-row Supabase UPDATE (separate from the rate-limited geocode call) doesn't need to be inline — for 500 properties this is 500 extra DB round trips beyond the unavoidable 500 Mapbox calls.
- **Recommendation:** Accumulate `{id, lat, lng}` results in memory during the rate-limited loop, then issue a single batched `upsert()` (or a few chunked upserts) after the loop completes, decoupling the DB write count from the external-API rate limit.

---

### LOW: Orphaned duplicate cron function `dailyMaintenanceCheck` not registered, but contains the same N+1 patterns
- **Area:** N+1 Query (dormant)
- **Location:** `lib/inngest/functions/maintenance-check.ts` (entire file; not imported/registered in `app/api/inngest/route.ts`)
- **Description:** This file defines `dailyMaintenanceCheck`, a near-duplicate of `cron/maintenance-schedules.ts` + `cron/work-order-ops.ts` (same `0 13 * * *` cron, same `getPmEmail`-per-schedule pattern). It is not imported into `app/api/inngest/route.ts`'s `serve()` call, so it never runs.
- **Risk:** No active risk, but dead code with the same N+1 issues described above could be accidentally re-registered (e.g. during a merge) and would then run *alongside* the newer split crons, doubling alert emails and DB writes for the same schedules.
- **Recommendation:** Delete `lib/inngest/functions/maintenance-check.ts` now that it has been superseded by `cron/maintenance-schedules.ts` and `cron/work-order-ops.ts` (per the comment at `app/api/inngest/route.ts:13`: "split from the old dailyMaintenanceCheck god function").

---

### LOW: No Vercel/Next.js caching configured anywhere — confirms no tenant-leakage risk, but also no read-scaling benefit
- **Area:** Caching
- **Location:** repo-wide; `vercel.json` (headers/security only, no cache-control rules); no `export const revalidate`, `unstable_cache`, `next: { revalidate }`, or `cache: 'force-cache'` found in `app/**` or `lib/**`
- **Description:** Every Server Component fetch goes through `createServerClient()` (RLS-enforced, per-request) with default Next.js dynamic rendering (no static/ISR caching). `vercel.json:21-36` only sets security headers (CSP, HSTS, etc.) — no `Cache-Control` directives.
- **Risk:** None for tenant isolation (good — there is nothing to leak across tenants). However, this means every dashboard page load re-runs all Supabase queries with no caching layer, which is the correct/safe default for multi-tenant RLS-scoped data, but offers no mitigation if Supabase read load becomes a bottleneck at scale (50 orgs × 50 properties).
- **Recommendation:** No change required for security. If read latency becomes a concern at scale, consider `unstable_cache` only for genuinely org-scoped, slow-changing data (e.g. `inventory_catalog`, `asset_type_standards`, `org_master_checklist_items` — global seed tables with no `org_id`) using cache keys/tags that do NOT vary by tenant (since these tables are intentionally global), while continuing to avoid caching anything under `app/(dashboard)/**` that includes `org_id`-scoped rows.

---

## N+1 Query Inventory

| File:Line | Loop construct | Query inside loop | Estimated scale | Suggested batch approach |
|---|---|---|---|---|
| `lib/inngest/functions/cron/asset-health.ts:95-119` | `for (const asset of orgAssets)` inside `for (const [orgId, orgAssets] of Object.entries(assetsByOrg))` | `supabase.from('property_assets').update(...).eq('id', asset.id)` | 50 orgs × ~150 assets = ~7,500 sequential UPDATEs/day | `upsert()` an array of `{id, health_score, health_score_updated_at}` per org (or one RPC for all orgs) |
| `lib/inngest/functions/cron/asset-health.ts:193-253` | `for (const doc of expiringDocs)` | `step.run` per doc: `org_milestones` select, `getPmEmail` (2 queries), `org_milestones` insert, `resend.emails.send` | Up to a few hundred docs across all orgs hitting a threshold on a given day | Batch-fetch existing milestones with `.in('milestone', [...])` once; use `getPmEmailsByOrgIds` once for distinct `org_id`s |
| `lib/inngest/functions/cron/maintenance-schedules.ts:59-152` | `for (const schedule of dueSchedules)` | `getPmEmail(supabase, schedule.org_id)` (2 queries) per schedule, plus per-schedule WO insert/update | 50 orgs × ~5 due schedules = ~250 schedules → ~500 extra queries just for PM email | Use `getPmEmailsByOrgIds()` once for all distinct `org_id`s before the loop |
| `lib/inngest/functions/cron/maintenance-schedules.ts:175-273` | `for (const schedule of overdueSchedules)` | `getPmEmail` (2 queries) + `work_orders` select per schedule | Similar scale to above | Same — batch PM emails; consider batching the `openWO` lookup with `.in('source_schedule_id', [...])` |
| `lib/inngest/functions/cron/work-order-ops.ts:44-91` | `for (const wo of agingWOs)` | `getPmEmail` (2 queries) per aging WO, plus update + insert per WO | 50 orgs × ~3-5 aging WOs = 150-250 → 300-500 extra queries | Batch PM emails via `getPmEmailsByOrgIds()`; batch `work_order_updates` inserts |
| `lib/inngest/functions/cron/work-order-ops.ts:116-164` | `for (const group of repeatGroups)` | `org_milestones` select + `getPmEmail` (2 queries) + delete + insert per group | Smaller (repeat-issue groups are rare) but same per-item PM-email pattern | Batch PM emails; batch milestone upserts |
| `lib/inngest/functions/cron/work-order-ops.ts:186-282` | `for (const schedule of autoWOSchedules)` | `existingWO` lookup + optional `vendors` lookup + `getPmEmail` (2 queries) per schedule | 50 orgs × ~2-3 due schedules = 100-150 → 200-300 extra queries | Pre-fetch existing WOs with `.in('source_schedule_id', [...])`; batch PM emails |
| `lib/inngest/functions/geocoding-backfill.ts:42-56,75-` | `for (const prop of batch)` / `for (const vendor of batch)` | `geocodeZip()` (external) + per-row `update().eq('id', ...)` | One-time backfill, bounded by external rate limit (200ms/row) | Decouple: accumulate results, single batched `upsert()` after the geocode loop |

---

## PowerSync Schema / Sync Rule Notes

- **No `sync_rules.yaml` or any PowerSync rule definition exists in the repository.** Sync rules must be configured entirely in the PowerSync Cloud dashboard for the project referenced by `NEXT_PUBLIC_POWERSYNC_URL` (`lib/powersync/client.ts:13`). This is the single largest gap for verifying "strictly filter by tenant_id" — there is nothing to review.
- `lib/powersync/client.ts`: the `SupabaseConnector.fetchCredentials()` (lines 9-16) authenticates using the Supabase session's `access_token`, which is the correct per-user credential pattern — this means the PowerSync backend *can* enforce per-user/per-org filtering via JWT claims in sync rules, assuming the rules are written correctly (unverifiable without the rules file).
- Tables in `lib/powersync/schema.ts` and their `org_id`/tenant-scoping status:
  - `turnovers` — has `org_id` ✅ (schema.ts:5)
  - `checklist_instances` — **no `org_id`** ⚠️ (DB has it; not exposed to client schema — schema.ts:14-17)
  - `checklist_instance_items` — no `org_id` (consistent with DB; relies on join via `instance_id` → `checklist_instances.org_id`)
  - `inventory_items` — **no `org_id`** ⚠️ (DB has it — schema.ts:31-38)
  - `properties` — **no `org_id`** ⚠️ (DB has it — schema.ts:40-45)
  - `crew_availability` — has `org_id` ✅ (schema.ts:47-53)
  - `messages` — has `org_id` ✅ (schema.ts:55-63)
- `SupabaseConnector.uploadData()` (`lib/powersync/client.ts:22-45`) only handles three `(table, op)` combinations (`checklist_instance_items` PUT, `turnovers` PUT status, `inventory_items` PUT current_quantity). Any other local write to a PowerSync table — including the fully-declared `crew_availability`, `messages`, and `properties` tables — is silently acknowledged (`transaction.complete()` always runs) but never persisted to Supabase. Combined with the missing `completed_at`/`completion_notes`/event-dispatch on the `turnovers` PUT handler (see Critical finding above), this connector is the central chokepoint for the local-first consistency issues found in this audit.
