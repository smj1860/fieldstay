# FieldStay Comprehensive Codebase Audit — Summary

**Date:** 2026-06-10
**Scope:** Full codebase, audited against `main` (commit `e0ddf01`) using four
specialized agents, one per dimension below. Each agent's full findings,
with file:line references, code excerpts, and recommendations, live in the
linked report.

| Report | Findings (Crit / High / Med / Low) |
|---|---|
| [01 — Security & Multi-Tenant Isolation](./01-security-multitenant-isolation.md) | 1 / 3 / 6 / 3 |
| [02 — Idempotency & Event Deduplication](./02-idempotency-deduplication.md) | 2 / 4 / 5 / 3 |
| [03 — PowerSync & Local-First Scalability](./03-powersync-scalability.md) | 1 / 4 / 5 / 3 |
| [04 — Business Logic & Tech Debt](./04-business-logic-tech-debt.md) | 0 / 4 / 1 / 3 |
| **Total** | **4 / 15 / 17 / 12** |

---

## Critical Findings (fix first)

1. **Migrations directory does not reflect the live schema/RLS state** — most
   core tables (`properties`, `work_orders`, `turnovers`, `organizations`,
   etc.) have no `CREATE TABLE` / `ENABLE RLS` / `CREATE POLICY` in
   `supabase/migrations/*.sql`, even though the live DB has RLS enabled with
   reasonable policies. A fresh environment provisioned from these migrations
   alone would be insecure (no RLS on most tables).
   → [01, "Migrations directory does not reflect live schema/RLS state"](./01-security-multitenant-isolation.md#critical-migrations-directory-does-not-reflect-live-schema-rls-state--cannot-be-used-to-provision-a-secure-environment)

2. **Auto-created maintenance work orders have no idempotency guard on
   retry** — `lib/inngest/functions/cron/maintenance-schedules.ts:60-93`
   inserts a `work_orders` row with `source = 'maintenance_schedule'` and no
   pre-insert existence check. An Inngest retry creates a duplicate WO every
   time.
   → [02, "Auto-created maintenance work orders..."](./02-idempotency-deduplication.md#critical-auto-created-maintenance-work-orders-have-no-idempotency-guard-on-retry)

3. **`create-purchase-order` step can create duplicate POs + line items on
   retry** — same root cause as #2, applied to purchase orders.
   → [02, "create-purchase-order step..."](./02-idempotency-deduplication.md#critical-create-purchase-order-step-can-create-duplicate-pos--line-items-on-retry)

4. **Crew "Mark Complete" bypasses the entire turnover-completion automation
   pipeline** — the crew PWA writes directly to PowerSync/SQLite and never
   emits `turnover/completed`, so the cleaning-fee expense, PM notification,
   and crew-duration recording (the app's *core automation promise*) silently
   never fire for turnovers completed via the crew app — i.e. the majority of
   real-world completions.
   → [03, "Crew Mark Complete bypasses..."](./03-powersync-scalability.md#critical-crew-mark-complete-bypasses-the-entire-turnover-completion-automation-pipeline)

---

## High-Priority Findings

**Security (01)**
- `org_master_checklist_items` / `org_master_maintenance_schedules`: only an
  `ALL` (admin/manager/owner) policy, no SELECT policy for crew/viewer.
- `owner_transactions`: no dedicated SELECT policy, relies solely on the
  admin/manager `ALL` policy.
- `oauth_states`: no policies found in `pg_policies` — likely intentional
  (service-role only) but undocumented/unconfirmed.

**Idempotency (02)**
- Overdue-schedule WO creation ("no open WO" branch) lacks a unique
  constraint backstop.
- Dead duplicate cron function `lib/inngest/functions/maintenance-check.ts`
  has drifted out of sync with its four registered replacements — maintenance
  hazard, should be deleted.
- `auto-assign-turnover.ts` autopilot insert relies on an unhandled
  unique-constraint error for dedup (silent failure mode).
- `record-outcomes` step does an unconditional INSERT with try/catch
  swallowing retries.

**PowerSync / Scalability (03)**
- Crew PWA writes `work_orders` directly via client-side Supabase, bypassing
  Server Actions and tenant-scoping conventions.
- `getPmEmail()` called per-item inside cron loops (`maintenance-schedules.ts`,
  `work-order-ops.ts`, `asset-health.ts`) despite an existing batched
  `getPmEmailsByOrgIds()` that's unused — hundreds of extra sequential round
  trips per run at scale.
- Per-asset sequential UPDATE inside the daily asset-health cron (no
  batching).
- No version-controlled PowerSync sync rules anywhere in the repo, and
  `lib/powersync/schema.ts` omits `org_id` from `properties`,
  `checklist_instances`, `inventory_items`.

**Business Logic / Tech Debt (04)**
- `work_order/completed` posts `estimated_cost` as the expense amount when
  `actual_cost` is null, contradicting the documented spec; `ignoreDuplicates:
  true` means a later real `actual_cost` never overwrites the placeholder.
- `handleWorkOrderCompletedViaPortal` can double-post (race-order-dependent
  amount) alongside `handleWorkOrderCompleted`.
- `types/database.ts` `WorkOrder.assigned_crew_id` is the **deprecated**
  column; `app/(dashboard)/maintenance/page.tsx:23` actively selects it
  instead of `assigned_crew_member_id` — exactly the bug class CLAUDE.md warns
  about.
- `organizations` interface is missing all 5 `repuguard_*` columns added by
  `20260601000000_repuguard.sql`, despite being read/written by
  `app/api/repuguard/activate/route.ts` and the Stripe webhook.

---

## What's Working Well

- No `.from('memberships')` references remain anywhere — the historical bug
  class is fully eradicated.
- `createServiceClient` (service-role) usage is confined to Inngest functions
  and specific server-side handlers; never reaches client components, logs,
  or responses.
- Stripe and OwnerRez webhooks correctly verify signatures and dedupe against
  a processed-event ledger (`owner_transactions_source_ref_unique` and a
  webhook-events ledger from `20260609000007_ownerrez_webhook_dedup.sql`).
- Core financial automation (`owner_transactions` for cleaning fees, WO
  completion, PO approval, booking revenue) is idempotent via
  `source_reference_id` + the `owner_transactions_source_ref_unique`
  constraint.
- Asset health score, MACRS depreciation, and crew auto-assignment scoring
  formulas are mathematically sound with correct guards against
  divide-by-zero and negative ages; weights are normalized to 1.0.
- Token-gated public portals (`/owner/[token]`, `/work-orders/[token]/**`,
  invite-acceptance flows) correctly verify expiry/revocation.
- Only one `: any` exists codebase-wide (`build-shopping-cart.ts:193`, due to
  unavoidable Inngest step type-inference loss).

---

## Suggested Remediation Order

1. **Fix the two CRITICAL idempotency gaps** (maintenance-schedule WO
   creation, PO creation) — small, surgical existence-check additions
   matching the pattern already used elsewhere in the same files.
2. **Fix the `types/database.ts` drift** (`assigned_crew_id` →
   `assigned_crew_member_id`, add `repuguard_*` columns to `organizations`) —
   low-risk, prevents a live runtime bug on the maintenance page.
3. **Fix the WO-completion `actual_cost`/`estimated_cost` expense bug** and
   the dual-handler double-post race.
4. **Address the crew "Mark Complete" automation gap** (03, CRITICAL) — this
   is the largest design fix (likely needs the crew action to call the same
   Server Action / emit the same Inngest event as the dashboard path), so
   plan it as its own focused workstream.
5. **Backfill `supabase/migrations/` to reflect the live RLS state** (01,
   CRITICAL) — write migrations that capture the *current* live policies (use
   `get_advisors`/`list_tables`/policy dumps from the Supabase project) so a
   fresh environment is provisioned securely. This is large but mostly
   mechanical.
6. Batch the cron `getPmEmail()` calls and asset-health UPDATEs (03, HIGH) —
   straightforward swap to existing batched helpers.
7. Remove the dead `lib/inngest/functions/maintenance-check.ts` (02, HIGH).
8. Address remaining MEDIUM/LOW items opportunistically during related
   feature work (see individual reports for full lists).
