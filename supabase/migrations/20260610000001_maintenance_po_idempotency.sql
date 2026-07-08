-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- Idempotency hardening for maintenance-schedule work orders and
-- inventory-count purchase orders (audit: 02-idempotency-deduplication.md, CRIT-1/2)

-- ── Maintenance schedule WOs: one per (schedule, due date) ───────────────────
-- Backstops the existingWO check in cron/maintenance-schedules.ts — prevents
-- duplicate work orders if a step is retried after a partial failure.
CREATE UNIQUE INDEX IF NOT EXISTS wo_maintenance_schedule_date_unique
  ON public.work_orders(source_schedule_id, scheduled_date)
  WHERE source = 'maintenance_schedule' AND source_schedule_id IS NOT NULL;

-- ── Purchase orders: one per inventory count ─────────────────────────────────
-- Backstops the existingCount check in inventory-events.ts — prevents
-- duplicate POs if the create-purchase-order step is retried.
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS source_count_id UUID
  REFERENCES public.inventory_counts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS po_source_count_unique
  ON public.purchase_orders(source_count_id)
  WHERE source_count_id IS NOT NULL;
