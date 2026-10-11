-- Vendor response states, per-work-order technician grants, and the vendor's
-- self-populating technician roster.
--
-- Phase B of docs/WO_VENDOR_RESPONSE_AND_SCHEDULING_SPEC.md.
--
-- WHY A SECOND AXIS RATHER THAN MORE wo_status VALUES. There are 16 hardcoded
-- open-status filter lists across the codebase (the board, /ops, the metrics
-- snapshot, PM notifications, the aging escalation, the inspection fan-out,
-- and more), every one a literal array like ['pending','assigned','in_progress'].
-- A seventh wo_status value means a work order sitting on 'parts_ordered'
-- silently drops out of all of them unless all 16 move in lockstep, with
-- nothing forcing it and no visible symptom. So wo_status stays the coarse
-- lifecycle the platform reasons about, and vendor_progress carries the detail
-- the vendor writes. lib/work-orders/vendor-progress.ts owns the mapping
-- between them and a guardrail asserts it is total over this enum.

CREATE TYPE public.vendor_progress AS ENUM (
  -- Declining and cancelling after accepting both return the work order to the
  -- unassigned queue, which is what makes it re-dispatchable at all:
  -- dispatchWorkOrderToVendor advances status behind a forward-only
  -- .in('status', ['pending','quote_requested']) filter.
  'declined',
  'cancelled_by_vendor',
  'appointment_scheduled',
  'on_the_way',
  'tech_on_site',
  -- The two BLOCKED states. Both notify the PM immediately rather than only
  -- sitting in a dropdown: the vendor cannot proceed and only the PM can
  -- unblock them, so a value nobody is told about would be the same silence
  -- this phase exists to remove.
  'awaiting_access',
  'hold_pm_approval',
  'parts_ordered',
  'repair_in_progress',
  'return_visit_scheduled',
  'job_completed'
);

-- An ENUM rather than free text because this is what feeds vendor scoring and
-- what a PM filters on when deciding whether to keep sending this vendor
-- plumbing work. A free-text reason is unsearchable and teaches the system
-- nothing. vendor_progress_note carries the prose alongside it.
CREATE TYPE public.vendor_decline_reason AS ENUM (
  'no_capacity',
  'outside_service_area',
  'not_my_trade',
  'price_below_minimum',
  'cannot_access_property',
  'other'
);

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS vendor_progress       public.vendor_progress,
  ADD COLUMN IF NOT EXISTS vendor_progress_at    timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_progress_note  text,
  ADD COLUMN IF NOT EXISTS vendor_accepted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_declined_at    timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_decline_reason public.vendor_decline_reason,
  ADD COLUMN IF NOT EXISTS vendor_dispatched_at  timestamptz;

COMMENT ON COLUMN public.work_orders.vendor_progress IS
  'The vendor-written detail axis. NULL on an assigned work order means '
  'dispatched with no response yet, which is what the dispatch-silence timer '
  'keys on. Never widened into wo_status - see this migration''s header.';

COMMENT ON COLUMN public.work_orders.vendor_dispatched_at IS
  'When the work order was sent to a vendor. The dispatch-silence timer reads '
  'THIS plus a null vendor_progress, deliberately not updated_at: the 7-day '
  'aging escalation keys on updated_at, so any note, photo or line item resets '
  'it and a vendor who documents progress pushes their own clock out.';

-- ── Per-work-order technician access ────────────────────────────────────────
--
-- PER WORK ORDER, not per technician: access dies with the job. A credential
-- that outlives the work is hard to claw back later.

CREATE TABLE IF NOT EXISTS public.vendor_technicians (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES public.vendors(id)        ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id)  ON DELETE CASCADE,
  -- Nullable: a technician opens the link and names himself before he is asked
  -- for a mobile, and supplying one is optional. The roster row exists either
  -- way; only a row WITH a number can be texted a future job.
  phone_e164    text,
  label         text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_technicians IS
  'A vendor''s own technicians, populated by the technician self-enrolling when '
  'they first open a work-order link - the vendor never types a phone number, '
  'so there are no typos to clean up and the consent is first-party rather than '
  'an employer volunteering an employee''s mobile. SERVICE-ROLE ONLY: these are '
  'a third party''s employees'' numbers. The PM needs attribution (completed by '
  'Mike), not the vendor''s staff list, so the name surfaces on the work order '
  'and the number never renders to the PM.';

-- The phone number IS the roster identity, so normalization decides whether
-- "(334) 555-1212", "334-555-1212" and "+13345551212" are one technician or
-- three. Writers go through normalizePhoneToE164() and store only E.164.
-- Partial, because a technician who gave no number still gets a row.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_technicians_vendor_phone_key
  ON public.vendor_technicians (vendor_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_technicians_vendor_id
  ON public.vendor_technicians (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_technicians_org_id
  ON public.vendor_technicians (org_id);

CREATE TABLE IF NOT EXISTS public.work_order_access_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id)       ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id)     ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES public.vendors(id)           ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: a roster entry going away must not delete the
  -- grant that recorded who did the work. Attribution outlives the roster.
  technician_id uuid REFERENCES public.vendor_technicians(id)         ON DELETE SET NULL,
  token         text NOT NULL UNIQUE,
  label         text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.work_order_access_grants IS
  'One technician''s access to ONE work order. Every write made through a grant '
  'stamps its id, so photos, line items and progress changes carry real '
  'attribution instead of the free-text name typed at the end. last_used_at '
  'answers "did he open it" per person, which is what the never-written '
  'work_orders.public_viewed_at column was supposed to do. expires_at is capped '
  'at the parent work order''s completion_token_expires_at by the issuing code: '
  'a technician token must never outlive the vendor''s own access. '
  'SERVICE-ROLE ONLY - the route validates the token in-file.';

CREATE INDEX IF NOT EXISTS idx_work_order_access_grants_work_order_id
  ON public.work_order_access_grants (work_order_id);
CREATE INDEX IF NOT EXISTS idx_work_order_access_grants_org_id
  ON public.work_order_access_grants (org_id);
CREATE INDEX IF NOT EXISTS idx_work_order_access_grants_vendor_id
  ON public.work_order_access_grants (vendor_id);
CREATE INDEX IF NOT EXISTS idx_work_order_access_grants_technician_id
  ON public.work_order_access_grants (technician_id);

-- RLS on, with NO policies, on both tables. That is the DESIGN rather than an
-- omission, and both are registered in check-db-invariants.mjs's
-- SERVICE_ROLE_ONLY_TABLES so a deny-all table nobody wrote the decision down
-- for stays distinguishable from a forgotten one. No authenticated or anon
-- GRANT is issued either: Postgres checks the grant before RLS, so there is
-- nothing for a policy to permit even if one were added by accident.
ALTER TABLE public.vendor_technicians       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_access_grants ENABLE ROW LEVEL SECURITY;
