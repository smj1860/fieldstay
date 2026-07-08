-- Speed up the turnover-cascade lookup in cancelBooking().
CREATE INDEX IF NOT EXISTS idx_turnovers_booking_id
  ON public.turnovers(booking_id)
  WHERE booking_id IS NOT NULL;

-- Allow a 'booking_cancellation' reversal row alongside the original
-- 'booking_revenue' / 'uplisting_booking' row for the same booking.
-- (source_reference_id, source) is UNIQUE, so the reversal needs its own
-- distinct `source` value rather than reusing 'booking_revenue'.
ALTER TABLE public.owner_transactions
  DROP CONSTRAINT IF EXISTS owner_transactions_source_check;

ALTER TABLE public.owner_transactions
  ADD CONSTRAINT owner_transactions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'wo_completion'::text,
    'booking_revenue'::text,
    'uplisting_booking'::text,
    'inventory_purchase'::text,
    'cleaning_fee'::text,
    'booking_cancellation'::text
  ]));
