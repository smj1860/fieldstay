-- Prevents duplicate manual bookings from double-submit or network retry.
-- Scoped to manual source only — iCal bookings use bookings_ical_uid_unique.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_manual_dates_unique
  ON public.bookings(property_id, checkin_date, checkout_date)
  WHERE source = 'manual' AND status != 'cancelled';
