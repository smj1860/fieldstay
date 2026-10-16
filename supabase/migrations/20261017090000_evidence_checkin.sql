-- Visit check-in: one location fix per turnover, inherited by every photo taken
-- during the visit. A check-in is a ledger event with no bytes behind it (same
-- shape as proof_of_care); photos sealed during the visit point at it through
-- refers_to_event_id, set by the seal route from the turnover's latest check-in.
--
-- Also: distances are FEET end to end. The browser reports GPS accuracy in
-- meters, the capture code converts it once, and the column is renamed so a
-- number in the ledger can never be mistaken for the other unit.

-- ── Units: gps_accuracy_m -> gps_accuracy_ft ─────────────────────────────────
-- The ledger is new and empty on both projects when this ships, so there is
-- nothing to convert. Guarded so a replay is a no-op. A rename is allowed under
-- the append-only triggers: it changes the catalog, not any row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'evidence_events' AND column_name = 'gps_accuracy_m')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'evidence_events' AND column_name = 'gps_accuracy_ft') THEN
    IF EXISTS (SELECT 1 FROM public.evidence_events WHERE gps_accuracy_m IS NOT NULL) THEN
      RAISE EXCEPTION 'evidence_events holds meter values; convert them before renaming gps_accuracy_m';
    END IF;
    ALTER TABLE public.evidence_events RENAME COLUMN gps_accuracy_m TO gps_accuracy_ft;
  END IF;
END $$;

COMMENT ON COLUMN public.evidence_events.gps_accuracy_ft IS
  'Reported GPS accuracy in FEET (the browser reports meters; it is converted once at capture).';

-- ── The new kind, and the source table it names ─────────────────────────────
ALTER TABLE public.evidence_events
  DROP CONSTRAINT IF EXISTS evidence_events_kind_valid;
ALTER TABLE public.evidence_events
  ADD CONSTRAINT evidence_events_kind_valid
    CHECK (kind IN ('photo_sealed', 'photo_withdrawn', 'packet_generated', 'proof_of_care', 'checkin'));

-- A check-in's source row is the turnover it opened.
ALTER TABLE public.evidence_events
  DROP CONSTRAINT IF EXISTS evidence_events_source_table_valid;
ALTER TABLE public.evidence_events
  ADD CONSTRAINT evidence_events_source_table_valid
    CHECK (source_table IN (
      'checklist_instance_items', 'checklist_instances', 'property_assets',
      'work_order_photos', 'inspection_items', 'turnover_flags', 'evidence_packets', 'turnovers'
    ));

-- A check-in must carry a fix; that is its whole content. turnover_id is NOT
-- required here on purpose: it is ON DELETE SET NULL, and a CHECK that demanded
-- it would make deleting a turnover that has a check-in fail.
ALTER TABLE public.evidence_events
  DROP CONSTRAINT IF EXISTS evidence_events_checkin_has_fix;
ALTER TABLE public.evidence_events
  ADD CONSTRAINT evidence_events_checkin_has_fix
    CHECK (kind <> 'checkin' OR (lat IS NOT NULL AND lng IS NOT NULL));

COMMENT ON CONSTRAINT evidence_events_checkin_has_fix ON public.evidence_events IS
  'A visit check-in exists only to record where the crew member was; without coordinates it is not one.';

-- The seal route looks up "latest check-in for this turnover" on every photo.
CREATE INDEX IF NOT EXISTS evidence_events_checkin_by_turnover_idx
  ON public.evidence_events (turnover_id, captured_at DESC)
  WHERE kind = 'checkin';

-- ── Per-property check-in radius ─────────────────────────────────────────────
-- Off-site distance per property. NULL uses the platform default
-- (lib/evidence/geo.ts GEOFENCE_WARN_FT). Feet, like every distance in the evidence code.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS geofence_radius_ft integer;
ALTER TABLE public.properties
  DROP CONSTRAINT IF EXISTS properties_geofence_radius_ft_range;
ALTER TABLE public.properties
  ADD CONSTRAINT properties_geofence_radius_ft_range
    CHECK (geofence_radius_ft IS NULL OR (geofence_radius_ft BETWEEN 150 AND 16000));
COMMENT ON COLUMN public.properties.geofence_radius_ft IS
  'A crew check-in farther than this from the property pin is flagged off site. NULL uses the default of 1,640 ft.';
