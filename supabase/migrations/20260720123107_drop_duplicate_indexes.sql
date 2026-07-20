-- Drops 6 pairs of byte-identical duplicate indexes flagged by the
-- Supabase performance advisor. Each pair has the exact same columns
-- (and predicate, where applicable) — Postgres maintains and consults
-- both on every write with zero additional query-planning benefit.
--
-- owner_transactions and crew_members each have one side of their pair
-- backed by a real UNIQUE CONSTRAINT (not just a plain index), so those
-- two use ALTER TABLE ... DROP CONSTRAINT rather than DROP INDEX.
-- Application code upserts by column list (onConflict: 'source_reference_id,source'),
-- never by constraint name, so keeping either side's columns intact is
-- sufficient — no app-code changes needed.

-- crew_feedback — keep the idx_-prefixed name (this codebase's dominant
-- index-naming convention), drop the _idx-suffixed duplicate.
DROP INDEX IF EXISTS crew_feedback_crew_member_id_idx;
DROP INDEX IF EXISTS crew_feedback_org_id_idx;

-- crew_members — crew_members_org_external_unique is the real UNIQUE
-- CONSTRAINT; crew_members_external_unique is a redundant plain index.
DROP INDEX IF EXISTS crew_members_external_unique;

-- owner_transactions — both sides are UNIQUE CONSTRAINTS backing the
-- source_reference_id/source idempotency guarantee. Keep the more
-- descriptive owner_transactions_source_ref_unique.
ALTER TABLE owner_transactions DROP CONSTRAINT IF EXISTS uq_owner_txn_source;

-- quote_requests — keep the name matching the actual column (quote_token).
DROP INDEX IF EXISTS idx_quote_requests_token;

-- turnovers — turnovers_standalone_unique is the current name (see
-- migration 20260707145545_turnovers_standalone_unique.sql);
-- turnovers_standalone_booking_unique is a leftover from before that rename.
DROP INDEX IF EXISTS turnovers_standalone_booking_unique;
