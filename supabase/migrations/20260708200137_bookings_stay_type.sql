-- Distinguishes an owner's personal-use stay at their own property from a
-- real paying guest reservation. Hospitable's reservation object carries
-- this as stay_type ('guest_stay' | 'owner_stay'); OwnerRez/Uplisting/iCal
-- sources default to 'guest_stay' since none of those integrations expose
-- an equivalent concept today. A turnover is still generated either way —
-- the property still needs cleaning after an owner stay — this column
-- exists to (a) badge it in the bookings/turnovers UI as a visual signal,
-- and (b) give the future owner-portal occupancy/revenue calculations and
-- any future Hospitable revenue-auto-posting a column to filter on.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS stay_type text NOT NULL DEFAULT 'guest_stay'
  CHECK (stay_type IN ('guest_stay', 'owner_stay'));
