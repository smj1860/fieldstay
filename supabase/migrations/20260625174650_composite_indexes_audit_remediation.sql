-- Composite indexes from 2026-06-25 operational audit

-- turnovers: dashboard + ops page filter on all three together
CREATE INDEX IF NOT EXISTS idx_turnovers_org_status_checkout
  ON public.turnovers (org_id, status, checkout_datetime);

-- work_orders: hot-path queries filter org + status together
CREATE INDEX IF NOT EXISTS idx_work_orders_org_status
  ON public.work_orders (org_id, status);

-- bookings: every booking-window query filters org + date range
CREATE INDEX IF NOT EXISTS idx_bookings_org_checkin
  ON public.bookings (org_id, checkin_date);

CREATE INDEX IF NOT EXISTS idx_bookings_org_checkout
  ON public.bookings (org_id, checkout_date);

-- owner_transactions: owners page filters org + sorts by date
CREATE INDEX IF NOT EXISTS idx_owner_transactions_org_date
  ON public.owner_transactions (org_id, transaction_date DESC);

-- audit_events: bounded today by 200-row cap but correct index shape
CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON public.audit_events (org_id, created_at DESC);

-- communication_logs: page sorts on communicated_at
CREATE INDEX IF NOT EXISTS idx_communication_logs_org_communicated
  ON public.communication_logs (org_id, communicated_at DESC)
  WHERE deleted_at IS NULL;
