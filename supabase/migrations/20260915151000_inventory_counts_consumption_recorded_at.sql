-- ============================================================================
-- Idempotency claim for consumption-sample recording.
--
-- recordConsumptionFromCount() derives a consumption "sample" purely from two
-- already-persisted count rows — nothing it reads is consumed or mutated, so
-- calling it twice for the same count_id computes the IDENTICAL sample both
-- times. record_consumption_samples() then merges that sample into the
-- item's one rolling-stats row (ON CONFLICT (inventory_item_id) DO UPDATE),
-- which has no idea a second call is a duplicate — it happily re-averages the
-- same rate in again, incrementing sample_count a second time and re-biasing
-- avg_rate_per_guest_night toward that one observation, silently corrupting
-- every future smart-par computation for that item.
--
-- Inngest guarantees only AT-LEAST-ONCE delivery, and the PM dashboard's
-- event producer (app/(dashboard)/inventory/actions.ts) sent
-- 'inventory/count-submitted' with no `id` at all — no Inngest-level dedup,
-- no DB-level guard, nothing that makes a second delivery (or a double-tapped
-- submit button, or a client retry after a timeout that actually succeeded)
-- a no-op. This column is the DB-side atomic claim: whichever delivery claims
-- it first proceeds, every other delivery for the same count is a guaranteed
-- no-op regardless of what protection the producer does or doesn't have.
-- ============================================================================

ALTER TABLE public.inventory_counts
  ADD COLUMN IF NOT EXISTS consumption_recorded_at timestamptz;
