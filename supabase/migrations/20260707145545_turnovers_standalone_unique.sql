-- Add a partial unique index for standalone turnovers (prev_booking_id IS NULL).
--
-- The existing turnovers_booking_pair_unique index only covers paired turnovers
-- (WHERE booking_id IS NOT NULL AND prev_booking_id IS NOT NULL). Without this
-- index, concurrent calls to generateTurnoversForProperty for the same property
-- can each insert a standalone turnover for the same booking, producing duplicate
-- rows that trigger duplicate crew notifications and checklist instances.

CREATE UNIQUE INDEX IF NOT EXISTS turnovers_standalone_unique
  ON public.turnovers (booking_id)
  WHERE booking_id IS NOT NULL AND prev_booking_id IS NULL;
