-- ============================================================================
-- recordThumbtackRequestCreatedAction() (lib/integrations/thumbtack-actions.ts)
-- deduped a completed Thumbtack request by running
--
--     SELECT id FROM audit_events
--     WHERE org_id = ... AND action = 'thumbtack.request_flow.completed'
--       AND metadata @> '{"request_pk": "..."}'
--
-- against audit_events — an ever-growing, append-only table with NO index on
-- `metadata` at all. Every call synchronously ran an unindexed JSONB
-- containment scan across that org's ENTIRE audit history, on the request
-- path, and the scan gets slower forever as the table grows. Worse, the
-- check-then-insert was not atomic: two concurrent calls (RequestFlowModal's
-- message listener re-subscribes on every parent re-render while the modal
-- stays open) could both see "not found" and both insert, so the dedup check
-- did not even reliably dedup.
--
-- Fix: a real dedupe_key column plus a unique index, same convention as
-- notifications.dedupe_key — the caller writes
-- `dedupeKey: 'thumbtack:' || request_pk` and the write itself becomes the
-- dedup check, via a plain INSERT that catches Postgres 23505 (unique
-- violation) rather than a separate SELECT beforehand. That is a single
-- indexed point lookup at write time instead of a full-history JSONB scan on
-- every call, and it closes the TOCTOU race a pre-check can never close.
--
-- PARTIAL (`WHERE dedupe_key IS NOT NULL`), unlike work_order_updates' and the
-- rebuilt notifications' PLAIN index: those two are named as an ON CONFLICT
-- arbiter by supabase-js's `onConflict` option, which cannot repeat a partial
-- index's predicate and throws 42P10 if the index is partial. This dedup path
-- uses a bare `.insert()` and catches the 23505 unique-violation error
-- directly — no ON CONFLICT clause anywhere — so the 42P10 restriction never
-- applies here, and PARTIAL is the right choice: audit_events is append-only
-- and every non-Thumbtack action never sets dedupe_key, so a plain unique
-- index would still work (NULLs are distinct there too) but the partial index
-- is the more honest declaration of intent — "this indexes only the rows that
-- opted into dedup" — for a column most audit_events writers never set.
-- ============================================================================

ALTER TABLE public.audit_events ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_dedupe_key_idx
  ON public.audit_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

COMMENT ON INDEX public.audit_events_dedupe_key_idx IS
  'Protects insert-time dedup for append-only audit_events writers (e.g. thumbtack.request_flow.completed) against a duplicate delivery/re-render. Partial (WHERE dedupe_key IS NOT NULL) because most audit_events writers never set this column, and — unlike notifications/work_order_updates dedupe_key — nothing here uses ON CONFLICT, so the 42P10 partial-index-as-arbiter restriction does not apply. Callers catch Postgres 23505 on a plain insert instead.';
