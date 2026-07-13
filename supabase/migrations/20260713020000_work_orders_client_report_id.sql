-- Self-audit fix — the crew "place work order" endpoint's idempotency check
-- (title + property_id + 10-minute window) had both a false-negative (a
-- retry delayed past 10 minutes, e.g. a dead-lettered outbox mutation
-- retried after the crew member reconnects, creates a real duplicate) and a
-- false-positive (two different genuine reports sharing a short title
-- within 10 minutes get silently collapsed into one, with no error
-- surfaced to the crew member). A client-generated id carried through the
-- Dexie outbox and enforced via a DB-level unique constraint has neither
-- failure mode — it's correct regardless of how long a retry is delayed.
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS client_report_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_client_report_id_unique
  ON public.work_orders(client_report_id)
  WHERE client_report_id IS NOT NULL;
