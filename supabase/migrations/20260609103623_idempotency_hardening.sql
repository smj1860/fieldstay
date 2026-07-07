-- Idempotency & Network Resilience Audit — DB-level constraints and RPC helpers

-- ── CRIT-1: Stripe at-least-once deduplication table ─────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_processed_events (
  stripe_event_id TEXT        PRIMARY KEY,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;

-- ── CRIT-2/6: owner_transactions idempotency backstop ────────────────────────
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

CREATE UNIQUE INDEX IF NOT EXISTS wo_crew_flag_source_unique
  ON public.work_orders(source_turnover_id)
  WHERE source = 'crew_flag' AND source_turnover_id IS NOT NULL;

-- ── HVI-2: bookings iCal uid uniqueness ──────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS bookings_ical_uid_unique
  ON public.bookings(ical_feed_id, ical_uid)
  WHERE ical_uid IS NOT NULL;

-- ── HVI-3: owner_portal_tokens per-owner uniqueness ──────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_single_unique
  ON public.owner_portal_tokens(property_owner_id)
  WHERE is_multi IS NOT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_multi_unique
  ON public.owner_portal_tokens(property_owner_id)
  WHERE is_multi = TRUE;

-- ── HVI-4: org_invites active-email uniqueness ────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS org_invites_active_email_unique
  ON public.org_invites(org_id, email)
  WHERE accepted_at IS NULL;

-- ── HVI-5: atomic checklist replace RPC ──────────────────────────────────────
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
CREATE UNIQUE INDEX IF NOT EXISTS turnovers_booking_pair_unique
  ON public.turnovers(booking_id, prev_booking_id)
  WHERE booking_id IS NOT NULL AND prev_booking_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wo_photos_storage_path_unique
  ON public.work_order_photos(storage_path);
