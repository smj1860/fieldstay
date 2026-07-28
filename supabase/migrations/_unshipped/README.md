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
