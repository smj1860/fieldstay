# Archived Schema Snapshots

Hand-written, pre-migration-system schema dumps. Superseded by
`supabase/migrations/`, and moved here from the repo root on 2026-07-27.

**These are not applied and must never be run.** They no longer match the live
schema and have not for a long time — the migration history in
`supabase/migrations/` is the sole source of truth for schema state. They are
kept only so the early shape of the schema stays readable when tracing why
something was built the way it was.

| File | What it was |
|---|---|
| `fieldstay_migration_v1.SUPERSEDED.sql` | Initial full schema |
| `fieldstay_migration_v2.SUPERSEDED.sql` | Incremental follow-up to v1 |

For the current schema, use `supabase/schema_reference.sql` (auto-generated —
regenerate with `bash scripts/generate-schema-reference.sh`), or query the live
database, which is always authoritative over any file in the repo.
