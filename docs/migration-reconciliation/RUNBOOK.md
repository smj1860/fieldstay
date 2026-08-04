# Migration ledger reconciliation — runbook (H10)

> ## ✅ COMPLETED 2026-08-03
>
> Steps 1 and 2 were executed against `vpmznjktllhmmbfnxuvk` via direct SQL
> against `supabase_migrations.schema_migrations`, NOT the Supabase CLI — the
> CLI is not installed on the operator's machine, and `migration repair` only
> INSERTs/DELETEs rows in that table, so the two are equivalent. No schema was
> touched.
>
> | | Before | After |
> |---|---|---|
> | Ledger rows | 311 | **312** |
> | Local migration files | 312 | 312 |
> | Versions in live but not local | 35 | **0** |
> | Versions in local but not live | 36 | **0** |
> | Ledger names embedding a stray timestamp | 5 | **0** |
>
> Verified after: exact 1:1 set equality in both directions, and
> `db_invariant_report()` byte-identical to before — production still passes
> all nine checks.
>
> **`supabase db push` is now safe to run.** It should report nothing pending.
> If it wants to apply anything, stop and re-check before proceeding.
>
> The command lists below are retained as the record of what was applied.

Generated 2026-08-03 against project `vpmznjktllhmmbfnxuvk`.

## What is wrong

`supabase db push` currently sees 36 local migration files as unapplied and
would re-run them. They ARE applied — they were applied through MCP
`apply_migration`, which stamps the ledger with the APPLICATION time rather
than the file's timestamp, so `version` never matches the filename.

Re-running them is not safe to assume away. Most are idempotent
(`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), but the set includes a
revoke/restore pair — `20260801280000_authz_gate_security_definer_rpcs`
revokes a grant and `20260801290000_assign_wo_number_security_definer`
restores it — and a partial or reordered replay breaks work-order inserts.

~~**Do not run `supabase db push` until this runbook has been completed.**~~ — completed, see the banner above.

## State at generation time

| | Count |
|---|---|
| Live ledger entries | 311 |
| Local migration files | 312 |
| Matched by version (clean) | 276 |
| Same migration under a different version (renumbered) | 35 |
| Local file with no ledger entry of any kind | 1 (`20260803160000`, applied via `execute_sql`) |

Two of the 35 had NO local file at all until 2026-08-03 — production held
schema the repo could not reproduce. Both were recovered verbatim from
`supabase_migrations.schema_migrations.statements` and committed:

  - `20260730140000_atomic_subscription_plan_update.sql`
  - `20260730150000_fix_checklist_started_at_trigger_collision.sql`

Their live definitions were verified to match the recovered SQL before the
files were written, so both describe the CURRENT function.

## Before you start

1. Confirm PITR / a recent backup exists. Every step below is metadata-only
   and touches no schema, but the ledger is not something to restore by hand.
2. `docs/migration-reconciliation/live-ledger-2026-08-03.txt` holds the 311
   live versions as of generation.
3. `supabase link --project-ref vpmznjktllhmmbfnxuvk` if not already linked.

## Step 1 — record the file versions as applied

Inserts a ledger row at each FILE's version so `db push` stops seeing them as
pending. No SQL runs against the schema.

```bash
supabase migration repair --status applied 20260730100000
supabase migration repair --status applied 20260730101000
supabase migration repair --status applied 20260730102000
supabase migration repair --status applied 20260730103000
supabase migration repair --status applied 20260730104000
supabase migration repair --status applied 20260730105000
supabase migration repair --status applied 20260730106000
supabase migration repair --status applied 20260730107000
supabase migration repair --status applied 20260730108000
supabase migration repair --status applied 20260730109000
supabase migration repair --status applied 20260730110000
supabase migration repair --status applied 20260730140000
supabase migration repair --status applied 20260730150000
supabase migration repair --status applied 20260730300000
supabase migration repair --status applied 20260730400000
supabase migration repair --status applied 20260730500000
supabase migration repair --status applied 20260730600000
supabase migration repair --status applied 20260730610000
supabase migration repair --status applied 20260730700000
supabase migration repair --status applied 20260731000000
supabase migration repair --status applied 20260731100000
supabase migration repair --status applied 20260731200000
supabase migration repair --status applied 20260731201000
supabase migration repair --status applied 20260801100000
supabase migration repair --status applied 20260801200000
supabase migration repair --status applied 20260801210000
supabase migration repair --status applied 20260801220000
supabase migration repair --status applied 20260801230000
supabase migration repair --status applied 20260801240000
supabase migration repair --status applied 20260801250000
supabase migration repair --status applied 20260801260000
supabase migration repair --status applied 20260801270000
supabase migration repair --status applied 20260801280000
supabase migration repair --status applied 20260801290000
supabase migration repair --status applied 20260802120000
supabase migration repair --status applied 20260803160000   # applied via execute_sql, no ledger row
```

## Step 2 — drop the duplicate application-time rows

Optional but recommended: without it the ledger carries both versions for each
migration (346 rows). With it, the ledger returns to a clean 1:1 with the
files. Deletes ledger rows only — the schema those migrations produced is
untouched.

```bash
supabase migration repair --status reverted 20260730213349
supabase migration repair --status reverted 20260731073718
supabase migration repair --status reverted 20260731073742
supabase migration repair --status reverted 20260731073757
supabase migration repair --status reverted 20260731073818
supabase migration repair --status reverted 20260731073832
supabase migration repair --status reverted 20260731073848
supabase migration repair --status reverted 20260731073858
supabase migration repair --status reverted 20260731073924
supabase migration repair --status reverted 20260731073941
supabase migration repair --status reverted 20260731073953
supabase migration repair --status reverted 20260731074004
supabase migration repair --status reverted 20260731074028
supabase migration repair --status reverted 20260731074054
supabase migration repair --status reverted 20260731074102
supabase migration repair --status reverted 20260731074111
supabase migration repair --status reverted 20260731074138
supabase migration repair --status reverted 20260731074239
supabase migration repair --status reverted 20260731152447
supabase migration repair --status reverted 20260731163215
supabase migration repair --status reverted 20260731174300
supabase migration repair --status reverted 20260801002524
supabase migration repair --status reverted 20260801002539
supabase migration repair --status reverted 20260801004907
supabase migration repair --status reverted 20260801054342
supabase migration repair --status reverted 20260801095333
supabase migration repair --status reverted 20260801120247
supabase migration repair --status reverted 20260801120530
supabase migration repair --status reverted 20260801120920
supabase migration repair --status reverted 20260801120933
supabase migration repair --status reverted 20260801121037
supabase migration repair --status reverted 20260801122422
supabase migration repair --status reverted 20260801150136
supabase migration repair --status reverted 20260801215556
supabase migration repair --status reverted 20260802002907
```

## Step 3 — verify

```bash
supabase migration list          # local and remote should agree, no pending
npm run check:db-invariants:prod # production must still pass all nine checks
bash scripts/generate-schema-reference.sh
```

`supabase db push` should report nothing to apply. If it wants to apply
anything, STOP — the reconciliation is incomplete and pushing will replay it.

## Step 4 — stop it recurring

The cause is `apply_migration` being used to apply schema, which CLAUDE.md
already restricts to verification/introspection. That is a convention, and a
convention is what failed here. A ledger-parity check belongs in
`scripts/check-db-invariants.mjs`, which already holds DB credentials in CI:
compare `supabase_migrations.schema_migrations.version` against the filenames
in `supabase/migrations/` and fail on any mismatch in either direction. That
would have caught this the day it happened rather than during an audit.

## Pairing reference

Local file version → live application-time version:

| File version | Live version | File |
|---|---|---|
| `20260730100000` | `20260731073718` | 20260730100000_drop_org_members_insert_self_privilege_escalation.sql |
| `20260730101000` | `20260731073742` | 20260730101000_compliance_docs_storage_policies_org_scoped.sql |
| `20260730102000` | `20260731073757` | 20260730102000_crew_scoping_rls_helpers.sql |
| `20260730103000` | `20260731073818` | 20260730103000_work_order_turnover_photo_storage_policies.sql |
| `20260730104000` | `20260731073832` | 20260730104000_grant_authenticated_and_drop_dead_policies.sql |
| `20260730105000` | `20260731073848` | 20260730105000_vendor_compliance_status_active_docs_and_null_expiry.sql |
| `20260730106000` | `20260731073858` | 20260730106000_tighten_viewer_writable_insert_policies.sql |
| `20260730107000` | `20260731073924` | 20260730107000_fk_on_delete_corrections.sql |
| `20260730108000` | `20260731073941` | 20260730108000_org_id_foreign_keys.sql |
| `20260730109000` | `20260731073953` | 20260730109000_index_hygiene_and_turnover_shape_check.sql |
| `20260730110000` | `20260731074239` | 20260730110000_db_invariant_report_security_sections.sql |
| `20260730140000` | `20260730213349` | 20260730140000_atomic_subscription_plan_update.sql |
| `20260730150000` | `20260731163215` | 20260730150000_fix_checklist_started_at_trigger_collision.sql |
| `20260730300000` | `20260731074004` | 20260730300000_purge_orphaned_organizations.sql |
| `20260730400000` | `20260731074138` | 20260730400000_scalability_aggregate_rpcs.sql |
| `20260730500000` | `20260731074028` | 20260730500000_vendor_stripe_connect_token_expiry.sql |
| `20260730600000` | `20260731074054` | 20260730600000_enforce_property_plan_limit.sql |
| `20260730610000` | `20260731074102` | 20260730610000_inventory_below_par_for_org_rpc.sql |
| `20260730700000` | `20260731074111` | 20260730700000_private_photo_buckets_and_path_normalization.sql |
| `20260731000000` | `20260731174300` | 20260731000000_turnover_crew_duration_minutes.sql |
| `20260731100000` | `20260731152447` | 20260731100000_db_invariant_report_storage_bucket_ids.sql |
| `20260731200000` | `20260801002524` | 20260731200000_drop_unconditional_integration_connections_org_provider_uniq.sql |
| `20260731201000` | `20260801002539` | 20260731201000_role_gate_property_door_code_rpcs.sql |
| `20260801100000` | `20260801004907` | 20260801100000_add_profile_unsubscribe_token.sql |
| `20260801200000` | `20260801054342` | 20260801200000_complete_work_order_via_token_rpc.sql |
| `20260801210000` | `20260801095333` | 20260801210000_scope_work_orders_crew_select_to_same_org.sql |
| `20260801220000` | `20260801120247` | 20260801220000_quote_requests_unique_work_order_vendor.sql |
| `20260801230000` | `20260801120530` | 20260801230000_remove_crew_from_turnover_rpc.sql |
| `20260801240000` | `20260801120920` | 20260801240000_fix_inventory_count_draft_status_vocabulary.sql |
| `20260801250000` | `20260801120933` | 20260801250000_approve_inventory_count_draft_rpc.sql |
| `20260801260000` | `20260801121037` | 20260801260000_apply_inventory_counts_rpc.sql |
| `20260801270000` | `20260801122422` | 20260801270000_approve_quote_request_rpc.sql |
| `20260801280000` | `20260801150136` | 20260801280000_authz_gate_security_definer_rpcs.sql |
| `20260801290000` | `20260801215556` | 20260801290000_assign_wo_number_security_definer.sql |
| `20260802120000` | `20260802002907` | 20260802120000_approve_quote_request_lock_order.sql |

---

## Follow-up: the E2E project is diverged too (open)

Recorded 2026-08-04 while building `scripts/check-migration-ledger.mjs`, which
had to be pointed at both projects.

`syhthijeqlnltufdawyb` (fieldstay-e2e) is diverged from `supabase/migrations/`
by **203 versions**: 70 local files with no ledger row, 133 ledger rows with no
local file. That is worse than production ever was.

**Its schema is current.** Spot-checked directly rather than inferred —
`db_invariant_report`, `db_type_shape_report`,
`update_organization_subscription_from_stripe`, `integration_entity_owners`,
`promo_hospitable_launch_counter`, `guidebook_offer_redemptions`,
`turnovers.crew_duration_minutes`, the `vacancy_gap_suggestion` enum label and
`profiles.unsubscribe_token` are all present. So this is bookkeeping, not
missing DDL, and no E2E test is running against a stale schema.

Two consequences that are real:

- **`supabase db push` against the E2E project is unsafe**, for exactly the
  reason it was unsafe against production before this runbook was executed.
- CLAUDE.md and `.github/workflows/ci.yml` used to claim "both projects receive
  every migration, so invariants verified there hold for production by
  construction." That is false, and both statements have been corrected. An
  E2E `db-invariants` pass is evidence about the E2E project only; verify
  production deliberately with `pnpm run check:db-invariants:prod` and
  `pnpm run check:migration-ledger:prod`.

The divergence is frozen in `scripts/migration-ledger-baseline.json` under the
`syhthijeqlnltufdawyb` key so the required check is not permanently red. That
freeze is shrink-only and is **not** an endorsement — burning it down is the
same procedure as the two steps above, run against this project instead. Lock
in progress with:

```
node scripts/check-migration-ledger.mjs --update
```

which refuses to grow the set.

### Repair log — E2E, 2026-08-04

One row realigned, an instance of the "same migration under a different
version (renumbered)" class in the table above, created the same day it was
caught:

| | Version | Name |
|---|---|---|
| Local file | `20260804125424` | `drop_inventory_count_drafts` |
| E2E ledger row (before) | `20260804134220` | `drop_inventory_count_drafts` |
| E2E ledger row (after) | `20260804125424` | `drop_inventory_count_drafts` |

Cause: the migration was applied to E2E through MCP `apply_migration`, which
stamps its own generation timestamp rather than honouring the version declared
in the filename. The schema was correct throughout — only the ledger's record
of *which* file produced it was wrong, which is exactly the divergence that is
invisible from the repo.

Repaired with a metadata-only `UPDATE` of `version` on that single row (the
equivalent of `supabase migration repair`, per the note at the top of this
file). Nothing else in the row changed, and no schema was touched.

Deliberately NOT added to `scripts/migration-ledger-baseline.json`. The E2E
baseline exists to freeze divergence *inherited* from the July branch, and
padding it with drift created after the gate was written would blunt the gate
on its first day. New drift gets repaired; only the historical set is frozen.

Post-repair parity: production `0 / 0` (hard gate), E2E `70 / 133` — exactly
the frozen baseline, with no new and no stale entries.
