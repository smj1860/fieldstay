-- ============================================================================
-- [HIGH] checklist_instance_items has no index supporting the nightly
-- Bayesian signal scan's filter/sort columns.
--
-- lib/inngest/functions/cron/checklist-signals.ts (cron-checklist-signals,
-- 11pm CT) reads, paginated, in exactly this shape:
--
--   .from('checklist_instance_items')
--   .eq('is_completed', true)
--   .gte('completed_at', windowStart)      -- rolling 180-day window
--   .order('completed_at', { ascending: false })
--
-- ordering DESC is load-bearing there (streak detection walks the most
-- recent completions backwards). With no index on these columns this is a
-- full sequential scan of the entire table plus an in-memory sort, every
-- night, and it only gets worse as checklist_instance_items grows with
-- platform age x turnover volume — exactly the table this cron already
-- windows to 180 days specifically to bound its OWN working set; without a
-- matching index, the WHERE/ORDER BY still costs a full scan to produce that
-- bounded set.
--
-- A partial index on `is_completed = true` (rather than a plain index on the
-- column) matches the `.eq('is_completed', true)` filter exactly and is
-- smaller and cheaper to maintain than indexing every row — most
-- checklist_instance_items rows are not yet completed, and this index is
-- useless for them.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and this
-- repo's migration files carry no other statements once CONCURRENTLY is
-- used (grepped supabase/migrations/*.sql: the only prior CONCURRENTLY
-- reference is a comment recommending `REFRESH MATERIALIZED VIEW
-- CONCURRENTLY`, never actually run) — so this index gets its own,
-- single-statement migration file rather than sharing one with any other DDL.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_checklist_instance_items_completed_at
  ON public.checklist_instance_items (completed_at DESC)
  WHERE is_completed = true;
