-- Pre-launch audit 2026-07-30 — index hygiene and one missing shape
-- constraint. Every index below was checked against the actual query that
-- would use it; the two the audit suggested that no query benefits from are
-- deliberately NOT created (see the note at the bottom).

-- ── 1. Redundant duplicate unique index on bookings ───────────────────────
-- bookings_ical_feed_id_ical_uid_key  UNIQUE (ical_feed_id, ical_uid)
-- bookings_ical_uid_unique            UNIQUE (ical_feed_id, ical_uid) WHERE ical_uid IS NOT NULL
-- The partial one is strictly weaker: NULLs are already distinct in a plain
-- unique index, so it enforces nothing the full index doesn't, while costing
-- a second insert-time write on the hottest ingest path (iCal sync upserts
-- every booking every hour). The full index is a real UNIQUE CONSTRAINT and
-- is what `onConflict: 'ical_feed_id,ical_uid'` resolves against, so dropping
-- the partial one leaves the upsert intact.
DROP INDEX IF EXISTS public.bookings_ical_uid_unique;

-- ── 2. Turnover uniqueness: close the uncovered shape ─────────────────────
-- turnovers_booking_pair_unique  UNIQUE (booking_id, prev_booking_id) WHERE both NOT NULL
-- turnovers_standalone_unique    UNIQUE (booking_id)                  WHERE booking_id NOT NULL AND prev_booking_id IS NULL
-- leaving (booking_id IS NULL AND prev_booking_id IS NOT NULL) with no
-- uniqueness at all.
--
-- A third partial unique index would be the wrong fix: that shape is not a
-- legitimate turnover. lib/turnovers/generator.ts represents a departure-only
-- turnover as booking_id = the DEPARTING booking with prev_booking_id NULL
-- (insertStandaloneTurnover, lines 178-196) and only ever sets prev_booking_id
-- while simultaneously setting booking_id (upgradeStandaloneToPair line 231,
-- insertPairTurnover line 275). Zero rows of that shape exist in production
-- (verified 2026-07-30: 46 pair, 37 standalone, 3 fully-manual, 0
-- departure-only). So forbid it, which also makes the two existing partial
-- indexes exhaustive over every shape except (NULL, NULL) — the manual
-- turnover, which is deliberately unconstrained.
ALTER TABLE public.turnovers
  DROP CONSTRAINT IF EXISTS turnovers_prev_booking_requires_booking;
ALTER TABLE public.turnovers
  ADD  CONSTRAINT turnovers_prev_booking_requires_booking
  CHECK (prev_booking_id IS NULL OR booking_id IS NOT NULL);

-- ── 3. Composite indexes for the platform-wide (cross-org) cron scans ─────
-- These crons deliberately scan every tenant, so the existing org-scoped
-- composites (idx_turnovers_org_status_checkout, idx_work_orders_org_status)
-- cannot serve them — their leading column is org_id.

-- lib/inngest/functions/cron/work-order-ops.ts:42-47
--   .in('status', ['pending','assigned','in_progress'])
--   .neq('priority','urgent')
--   .lt('updated_at', sevenDaysAgo)
CREATE INDEX IF NOT EXISTS idx_work_orders_status_updated_at
  ON public.work_orders (status, updated_at);

-- lib/inngest/functions/cron/crew-score-recompute.ts:34-37
--   .in('status', ['assigned','in_progress'])
--   .lt('checkout_datetime', cutoff)
CREATE INDEX IF NOT EXISTS idx_turnovers_status_checkout
  ON public.turnovers (status, checkout_datetime);

-- lib/inngest/functions/cron/turnover-priority-decay.ts:30-34
--   .is('prev_booking_id', null).eq('priority','medium')
--   .not('status','in','("completed","cancelled")')
-- Partial on exactly the cron's predicate: the live turnovers table is
-- dominated by completed rows, so the partial form stays small permanently.
CREATE INDEX IF NOT EXISTS idx_turnovers_priority_decay
  ON public.turnovers (priority)
  WHERE prev_booking_id IS NULL
    AND status <> 'completed'::turnover_status
    AND status <> 'cancelled'::turnover_status;

-- lib/inngest/functions/cron/notifications-retention.ts:47-50
--   .lt('created_at', cutoffIso) [.not('read_at','is',null)] — global, so
-- notifications_org_created_idx (org_id first) is unusable for it.
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
  ON public.notifications (created_at);

-- ── Deliberately NOT created ──────────────────────────────────────────────
-- property_assets(is_active) and ical_feeds(is_active): both crons
-- (cron/asset-health.ts:45-52, ical-sync.ts:60-66) filter `is_active = true`
-- and nothing else, and the overwhelming majority of rows in both tables are
-- active. A btree on a near-constant column is never chosen by the planner —
-- a sequential scan IS the correct plan for "fetch ~all rows" — and the index
-- would only add write cost. The real defect in both crons is that the select
-- is unbounded against max_rows = 1000 (audit dimension 4), which is a code
-- fix, not an index.
