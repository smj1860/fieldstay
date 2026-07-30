# `_unshipped/` — migrations deliberately not applied

Holds migration files that are kept for reference but are **not** part of the
applied migration history.

## What is in here

`20260618000002_baseline_schema_snapshot.sql` — a generated snapshot of the
live structure (columns, RLS, constraints, indexes, policies, grants) of the
~50 tables that existed in the live project but had no corresponding
`CREATE TABLE` migration in this directory, captured 2026-06-18 during the
migration-drift reconciliation.

It exists to make the schema of those tables readable from the repo. It was
never meant to run: the tables it describes already exist in the live project,
which is exactly why the snapshot was needed in the first place.

**69 additional files** (68 on 2026-07-28; `20260617000003_add_missing_fk_indexes.sql`
added 2026-07-30 — same pattern, missed by the original pass) — round-number-timestamped draft
migrations (e.g. `20260609000002_idempotency_hardening.sql`,
`20260714160500_property_assets_replaced_by_on_delete.sql`) that were never
recorded in `supabase_migrations.schema_migrations` under their own filename
timestamp. For each one, every table/column/index/function/policy it targets
was confirmed to already exist live (via `information_schema`, `pg_proc`,
`pg_indexes` introspection against project `vpmznjktllhmmbfnxuvk` on
2026-07-28) — the change these files describe was applied, just under a
different, real-timestamped migration elsewhere in `supabase/migrations/`
(the same drift pattern the June 18 snapshot above closes, but for files that
each already had their own dedicated local copy rather than none at all).
Each moved file has a one-line header recording this. See
`CLAUDE_LAUNCH_AUDIT_FIXES_1_CRITICAL.md` Task 4 for the full reconciliation
pass this came from — that pass also found and flagged one **genuine** gap
(`hospitable_launch_promo`, NOT moved here — see the task notes) where the
live database was actually missing schema that application code depends on,
underscoring that "local-only" is not automatically "safe to file away."

## Will it ever ship?

No. If the drift it documents ever needs to be re-closed, regenerate against
the live schema rather than replaying this file — it is a point-in-time
snapshot from June 2026 and the schema has moved on since.

## Why the underscore prefix

The Supabase CLI discovers migrations by filename in `supabase/migrations/`,
and a subdirectory whose name does not match the `<timestamp>_<name>.sql`
pattern is not a migration. The leading underscore also sorts it away from the
timestamped files.

> **Not independently verified.** The exclusion above is the intended design
> and is consistent with the fact that this file has never appeared in the
> applied history, but it was not confirmed against a running CLI (doing so
> needs a local Postgres or a linked project). Before adding anything else
> here, confirm with `supabase migration list --linked` that nothing in this
> directory shows up as pending.

What *is* verified: nothing in this repo reads this path — no script, no CI
workflow, no config entry — and `unit/guardrails/migration-hygiene.test.ts`
reads `supabase/migrations/` non-recursively and filters to `.sql`, so files
in here are outside its checks too.
