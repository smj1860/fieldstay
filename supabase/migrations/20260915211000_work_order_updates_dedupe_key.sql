-- ============================================================================
-- inspection-completed.ts's attachToOpenPredecessors() deduped its recurrence
-- note purely by reading existing work_order_updates rows into an in-memory
-- `seen` set and filtering the new insert against it. That is safe against a
-- SEQUENTIAL replay of the same step (a retry reads its own earlier write)
-- but not against two genuinely CONCURRENT executions of the same
-- inspection/completed event — Inngest's at-least-once delivery model does
-- not rule that out (a slow first attempt plus a redelivery, or two workers
-- picking up the same run). Two concurrent executions both read the same
-- empty `seen` set before either has written, and both insert an identical
-- "failed again" note.
--
-- Fix: a real DB-level uniqueness guarantee, same convention as
-- notifications.dedupe_key. One note per inspection_items row, ever —
-- dedupe_key = 'recurrence:' || inspection_items.id.
--
-- PLAIN, not partial, per the lesson already paid for on
-- notifications.dedupe_key (20260817172700_notifications_dedupe_key_plain_
-- unique_index.sql): a partial unique index cannot be named as an ON
-- CONFLICT arbiter by supabase-js's `onConflict` option, so an upsert against
-- it throws 42P10. NULLs are distinct in a plain unique index, so every other
-- work_order_updates insert site (status-change notes, none of which ever set
-- dedupe_key) keeps permitting unlimited NULL rows, unaffected by this.
-- ============================================================================

ALTER TABLE work_order_updates ADD COLUMN IF NOT EXISTS dedupe_key text;

DROP INDEX IF EXISTS public.work_order_updates_dedupe_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS work_order_updates_dedupe_key_idx
  ON public.work_order_updates (dedupe_key);

COMMENT ON INDEX public.work_order_updates_dedupe_key_idx IS
  'PLAIN, not partial, so ON CONFLICT (dedupe_key) can name it as an arbiter — see notifications_dedupe_key_idx for the same fix applied earlier. NULLs are distinct in a unique index, so ordinary (non-recurrence-note) work_order_updates rows, which never set dedupe_key, never collide.';
