-- Idempotency & Network Resilience Audit — DB-level constraints and RPC helpers
-- Must be applied before the corresponding code changes land.

-- ── CRIT-1: Stripe at-least-once deduplication table ─────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_processed_events (
  stripe_event_id TEXT        PRIMARY KEY,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;
-- No RLS policies = authenticated/anon denied; service role bypasses RLS

-- ── CRIT-2/6: owner_transactions idempotency backstop ────────────────────────
-- Prevents duplicate financial postings from concurrent or retried Inngest steps.
-- Any row with source_reference_id IS NOT NULL must be unique per (ref, source).
-- Existing rows where source_reference_id IS NULL are unaffected (NULL != NULL).
ALTER TABLE public.owner_transactions
  ADD CONSTRAINT owner_transactions_source_ref_unique
  UNIQUE (source_reference_id, source);

-- ── CRIT-4: turnover_assignments uniqueness backstop ─────────────────────────
ALTER TABLE public.turnover_assignments
  ADD CONSTRAINT turnover_assignments_crew_unique
  UNIQUE (turnover_id, crew_member_id);

-- ── CRIT-8: work_orders.source_turnover_id ───────────────────────────────────
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS source_turnover_id UUID
  REFERENCES public.turnovers(id) ON DELETE SET NULL;

-- One crew-flag WO per flagged turnover (prevents Inngest retry duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS wo_crew_flag_source_unique
  ON public.work_orders(source_turnover_id)
  WHERE source = 'crew_flag' AND source_turnover_id IS NOT NULL;

-- ── HVI-2: bookings iCal uid uniqueness (enables safe bulk upsert) ───────────
CREATE UNIQUE INDEX IF NOT EXISTS bookings_ical_uid_unique
  ON public.bookings(ical_feed_id, ical_uid)
  WHERE ical_uid IS NOT NULL;

-- ── HVI-3: owner_portal_tokens per-owner uniqueness ──────────────────────────
-- Full unique constraint enables PostgREST upsert on (property_owner_id, is_multi)
ALTER TABLE public.owner_portal_tokens
  ADD CONSTRAINT owner_portal_tokens_owner_type_unique
  UNIQUE (property_owner_id, is_multi);

-- Partial indexes for additional clarity
CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_single_unique
  ON public.owner_portal_tokens(property_owner_id)
  WHERE is_multi IS NOT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_multi_unique
  ON public.owner_portal_tokens(property_owner_id)
  WHERE is_multi = TRUE;

-- ── HVI-4: org_invites active-email uniqueness ────────────────────────────────
-- Prevents duplicate pending invitations to the same email in the same org.
CREATE UNIQUE INDEX IF NOT EXISTS org_invites_active_email_unique
  ON public.org_invites(org_id, email)
  WHERE accepted_at IS NULL;

-- ── HVI-5: atomic checklist replace RPC ──────────────────────────────────────
-- Called instead of a non-atomic delete + re-insert pair.
CREATE OR REPLACE FUNCTION public.replace_master_checklist_items(
  p_org_id uuid,
  p_items  jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.org_master_checklist_items
  WHERE org_id = p_org_id;

  IF jsonb_array_length(p_items) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.org_master_checklist_items (org_id, section, task, sort_order, source)
  SELECT
    p_org_id,
    (item ->> 'section'),
    (item ->> 'task'),
    (item ->> 'sort_order')::int,
    (item ->> 'source')
  FROM jsonb_array_elements(p_items) AS item;
END;
$$;

REVOKE ALL  ON FUNCTION public.replace_master_checklist_items(uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.replace_master_checklist_items(uuid, jsonb)
  TO authenticated, service_role;

-- ── HVI-7: inventory_templates one-per-org uniqueness ────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS inventory_templates_org_unique
  ON public.inventory_templates(org_id);

-- ── Supporting integrity constraints ─────────────────────────────────────────

-- Turnovers: booking-pair uniqueness (prevents generator duplicates on retry)
CREATE UNIQUE INDEX IF NOT EXISTS turnovers_booking_pair_unique
  ON public.turnovers(booking_id, prev_booking_id)
  WHERE booking_id IS NOT NULL AND prev_booking_id IS NOT NULL;

-- Work-order photos: storage path uniqueness (prevents double-upload on retry)
CREATE UNIQUE INDEX IF NOT EXISTS wo_photos_storage_path_unique
  ON public.work_order_photos(storage_path);
