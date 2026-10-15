-- ============================================================================
-- Stay Evidence Ledger, phase 1.
--
-- One append-only row per photo capture (and per withdrawal / packet / proof
-- event in later phases). The photo columns on checklist_instance_items,
-- checklist_instances, property_assets, inspection_items and work_order_photos
-- are untouched: they remain the "current pointer" the UI renders. This table
-- is the history, including every retake, so it is never updated in place.
--
-- Append-only is enforced by TRIGGER, not only by grant or policy, for the same
-- reason inspections are (20260822090115): the service role bypasses RLS, and
-- "immutable unless the backend feels otherwise" is not immutability.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.evidence_events (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id                 uuid NOT NULL REFERENCES public.properties(id)     ON DELETE CASCADE,

  kind                        text NOT NULL,
  source_table                text NOT NULL,
  source_id                   uuid NOT NULL,

  bucket                      text NOT NULL,
  storage_path                text NOT NULL,
  sha256                      text NOT NULL,
  byte_size                   integer,
  hash_verified               boolean NOT NULL DEFAULT false,

  -- Provenance. captured_at is the corrected instant used everywhere; the raw
  -- device claim and the measured skew are kept so a report can SHOW the
  -- correction, not just its result (same stance as inspections'
  -- device_started_at / device_clock_offset_seconds).
  captured_at                 timestamptz NOT NULL,
  captured_at_source          text NOT NULL DEFAULT 'server',
  device_captured_at          timestamptz,
  device_clock_offset_seconds integer,
  received_at                 timestamptz NOT NULL DEFAULT now(),

  lat                         numeric(9,6),
  lng                         numeric(9,6),
  gps_accuracy_m              numeric(8,1),

  captured_by_kind            text NOT NULL,
  captured_by_id              uuid,
  captured_by_label           text,

  turnover_id                 uuid REFERENCES public.turnovers(id)       ON DELETE SET NULL,
  work_order_id               uuid REFERENCES public.work_orders(id)     ON DELETE SET NULL,
  inspection_id               uuid REFERENCES public.inspections(id)     ON DELETE SET NULL,
  refers_to_event_id          uuid REFERENCES public.evidence_events(id) ON DELETE SET NULL,

  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_events_kind_valid
    CHECK (kind IN ('photo_sealed', 'photo_withdrawn', 'packet_generated', 'proof_of_care')),
  CONSTRAINT evidence_events_source_table_valid
    CHECK (source_table IN (
      'checklist_instance_items', 'checklist_instances', 'property_assets',
      'work_order_photos', 'inspection_items', 'turnover_flags', 'evidence_packets'
    )),
  CONSTRAINT evidence_events_bucket_valid
    CHECK (bucket IN ('turnover-photos', 'work-order-photos', 'inspection-photos', 'evidence-packets')),
  CONSTRAINT evidence_events_sha256_valid
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_events_captured_at_source_valid
    CHECK (captured_at_source IN ('server', 'device')),
  CONSTRAINT evidence_events_device_capture_has_evidence
    CHECK (
      captured_at_source <> 'device'
      OR (device_captured_at IS NOT NULL AND device_clock_offset_seconds IS NOT NULL)
    ),
  CONSTRAINT evidence_events_captured_by_kind_valid
    CHECK (captured_by_kind IN ('crew', 'pm', 'vendor', 'system')),
  CONSTRAINT evidence_events_gps_pair
    CHECK ((lat IS NULL) = (lng IS NULL))
);

-- A seal replay (outbox retry after a dropped response) must collide, not
-- duplicate. The storage path is UUID-keyed at capture, so (bucket, path, kind)
-- names one physical capture event. A withdrawal of the same path is a
-- different kind and so a different row.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_events_capture_unique
  ON public.evidence_events (org_id, bucket, storage_path, kind);

-- FK covering indexes (check-db-invariants #3) and the read paths.
CREATE INDEX IF NOT EXISTS evidence_events_property_captured_idx
  ON public.evidence_events (property_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS evidence_events_turnover_idx
  ON public.evidence_events (turnover_id) WHERE turnover_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_events_work_order_idx
  ON public.evidence_events (work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_events_inspection_idx
  ON public.evidence_events (inspection_id) WHERE inspection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_events_refers_to_idx
  ON public.evidence_events (refers_to_event_id) WHERE refers_to_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_events_source_idx
  ON public.evidence_events (source_table, source_id);

-- ── Immutability ────────────────────────────────────────────────────────────
--
-- UPDATE: rejected, with one exception, the FK ON DELETE SET NULL shape. The
-- exception is STRICT and per column, the same form the inspections trigger
-- uses (20260823180804): exactly ONE of the four nullable FK columns went
-- non-null -> null, and a probe row built from OLD with only that column taken
-- from NEW is identical to NEW. A looser test (copy all four FK columns from NEW
-- and compare) would let one statement null a column while REPOINTING another,
-- which is an edit to the record, not a referential cleanup.
CREATE OR REPLACE FUNCTION public.reject_evidence_event_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_probe public.evidence_events;
BEGIN
  IF OLD.turnover_id IS NOT NULL AND NEW.turnover_id IS NULL THEN
    v_probe := OLD; v_probe.turnover_id := NEW.turnover_id;
    IF v_probe IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  END IF;
  IF OLD.work_order_id IS NOT NULL AND NEW.work_order_id IS NULL THEN
    v_probe := OLD; v_probe.work_order_id := NEW.work_order_id;
    IF v_probe IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  END IF;
  IF OLD.inspection_id IS NOT NULL AND NEW.inspection_id IS NULL THEN
    v_probe := OLD; v_probe.inspection_id := NEW.inspection_id;
    IF v_probe IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  END IF;
  IF OLD.refers_to_event_id IS NOT NULL AND NEW.refers_to_event_id IS NULL THEN
    v_probe := OLD; v_probe.refers_to_event_id := NEW.refers_to_event_id;
    IF v_probe IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION 'evidence_events % is append-only', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_events_immutable_update ON public.evidence_events;
CREATE TRIGGER trg_evidence_events_immutable_update
  BEFORE UPDATE ON public.evidence_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_evidence_event_update();

-- DELETE: rejected when issued directly. A BEFORE ROW trigger runs at
-- pg_trigger_depth() >= 1 ALWAYS, so a direct DELETE arrives at depth 1 and the
-- check is "<= 1". A cascade from organizations or properties runs inside the
-- referential-integrity trigger, so it arrives at depth >= 2 and is allowed:
-- evidence dies with its property or tenant (account deletion), never on its own.
-- (An earlier draft tested "= 0", which can never be true inside a trigger, so
-- it rejected nothing. unit/evidence/ledger-triggers.test.ts runs this against a
-- real Postgres so that cannot silently happen again.)
CREATE OR REPLACE FUNCTION public.reject_evidence_event_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'evidence_events % is append-only; a withdrawal is a new row, not a delete', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_events_immutable_delete ON public.evidence_events;
CREATE TRIGGER trg_evidence_events_immutable_delete
  BEFORE DELETE ON public.evidence_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_evidence_event_delete();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Org members and crew read their own org's rows (the crew PWA may later show
-- "sealed" badges; it never reads this today). Nobody writes through RLS: every
-- insert comes from a route handler or Inngest step on the service role, after a
-- server-side hash check. `authenticated` holds only SELECT, so INSERT, UPDATE
-- and DELETE are denied by the missing GRANT, which Postgres checks before RLS.
-- Explicit deny policies were dropped: a policy on a command the role holds no
-- grant for is what check-db-invariants' policies_without_grant flags, and they
-- added nothing the grant does not already do.
ALTER TABLE public.evidence_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_events_select      ON public.evidence_events;
DROP POLICY IF EXISTS evidence_events_deny_insert ON public.evidence_events;
DROP POLICY IF EXISTS evidence_events_deny_update ON public.evidence_events;
DROP POLICY IF EXISTS evidence_events_deny_delete ON public.evidence_events;

CREATE POLICY evidence_events_select ON public.evidence_events
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    OR org_id IN (SELECT public.get_crew_org_ids())
  );

GRANT SELECT ON TABLE public.evidence_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.evidence_events TO service_role;

COMMENT ON TABLE public.evidence_events IS
  'Append-only ledger of sealed photo evidence and later packet/proof events. UPDATE and direct DELETE are rejected by trigger for every role.';

-- ============================================================================
-- Stay brackets: which guest stay(s) a piece of evidence speaks to.
--
-- Separate and recomputable on purpose. A turnover photo brackets TWO stays
-- (post-stay of the departing booking, pre-stay of the arriving one), and
-- turnover dates move after the photo exists, so this cannot live on the
-- immutable row. Written only by lib/evidence/bracket.ts via the service role.
--
-- Single-column PK with a UNIQUE pair, never PRIMARY KEY (event_id, booking_id):
-- PostgREST reads a two-FK composite PK as a junction and starts offering a
-- second embed path between evidence_events and bookings (CLAUDE.md,
-- check-db-invariants #10).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.evidence_stay_brackets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id)   ON DELETE CASCADE,
  evidence_event_id uuid NOT NULL REFERENCES public.evidence_events(id) ON DELETE CASCADE,
  booking_id        uuid NOT NULL REFERENCES public.bookings(id)        ON DELETE CASCADE,
  position          text NOT NULL,
  bracketed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_stay_brackets_position_valid
    CHECK (position IN ('pre_stay', 'during_stay', 'post_stay')),
  CONSTRAINT evidence_stay_brackets_pair_unique UNIQUE (evidence_event_id, booking_id)
);

CREATE INDEX IF NOT EXISTS evidence_stay_brackets_booking_idx
  ON public.evidence_stay_brackets (booking_id, position);
CREATE INDEX IF NOT EXISTS evidence_stay_brackets_org_idx
  ON public.evidence_stay_brackets (org_id);

ALTER TABLE public.evidence_stay_brackets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_stay_brackets_select ON public.evidence_stay_brackets;
CREATE POLICY evidence_stay_brackets_select ON public.evidence_stay_brackets
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

GRANT SELECT ON TABLE public.evidence_stay_brackets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.evidence_stay_brackets TO service_role;

COMMENT ON TABLE public.evidence_stay_brackets IS
  'Derived: which booking(s) an evidence event brackets and from which side. Recomputed by lib/evidence/bracket.ts; never edited by hand.';
