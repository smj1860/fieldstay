-- A PM can move a property's map pin to where a crew member last checked in
-- (Use last check-in, property details page). The pin is otherwise a ZIP-level
-- geocode, which is why a rural property reads as "away" on every visit.
--
-- location_pinned_at marks a pin a human set. Provider syncs (Hostaway, Hostex)
-- write lat/lng on every run, and without this marker the next sync would
-- silently put the ZIP-level pin back. Same shape as properties.seasonal_profile
-- and sponsor_assignment_mode: an automatic value must not overrule a deliberate
-- human one. NULL means the pin is automatic.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS location_pinned_at timestamptz;

COMMENT ON COLUMN public.properties.location_pinned_at IS
  'When a PM set lat/lng from a crew check-in. Non-NULL means provider syncs must not overwrite lat/lng. NULL means the pin is automatic.';
