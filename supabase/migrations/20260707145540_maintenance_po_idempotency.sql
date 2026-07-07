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
