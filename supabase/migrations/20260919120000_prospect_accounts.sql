-- Prospecting funnel: the outbound account list that /admin/prospects reads.
--
-- This is platform-internal go-to-market data, NOT tenant data: there is no
-- organization_id and no per-org policy. Every row is visible only to
-- platform_staff with role = 'admin', the same gate the seed-template and
-- inventory-catalog editors use (is_platform_staff_admin(), added in
-- 20260720120000_is_platform_staff_admin.sql). Deliberately NOT gated on
-- is_platform_staff(), which also passes for support staff — support has no
-- reason to read the sales pipeline.
--
-- status is text + CHECK rather than a pg enum: the funnel stages change as
-- the motion changes, and adding a value to a CHECK is a one-line migration
-- while ALTER TYPE ... ADD VALUE cannot run inside a transaction with other
-- DDL.

CREATE TABLE public.prospect_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identity
  company               text NOT NULL,
  domain                text,
  website               text,
  comparent_url         text,

  -- location
  city                  text,
  state                 text,
  market                text,
  region                text,

  -- size
  portfolio_size        integer,
  portfolio_size_method text,

  -- property management system
  pms                   text,
  pms_note              text,

  -- scoring (written by the offline scorer; editable here for one-offs)
  score_a               integer,
  score_b               integer,
  track                 text,
  bucket                text,
  gate                  text,

  -- contact
  contact_name          text,
  contact_title         text,
  email                 text,
  phone                 text,
  linkedin_url          text,

  -- funnel
  status                text NOT NULL DEFAULT 'new',
  status_note           text,
  notes                 text,
  last_touch_at         timestamptz,
  next_action_at        date,

  -- provenance
  source                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_accounts_status_check CHECK (status IN (
    'new',
    'researching',
    'needs_contact_info',
    'queued',
    'emailed',
    'called',
    'texted',
    'visited_no_contact',
    'replied',
    'meeting_set',
    'in_trial',
    'won',
    'lost',
    'disqualified'
  ))
);

-- A generic inbox (info@, support@, reservations@ …) is a different outreach
-- problem from a named person's address: it needs role-addressed copy and it
-- is a candidate for further contact discovery. Generated rather than stored
-- so it can never drift from the email column it describes.
ALTER TABLE public.prospect_accounts
  ADD COLUMN email_is_generic boolean
  GENERATED ALWAYS AS (
    email IS NOT NULL
    AND lower(split_part(email, '@', 1)) IN (
      'info','support','sales','contact','hello','admin','office','mail',
      'reservations','rentals','booking','bookings','frontdesk','team','inquiries'
    )
  ) STORED;

-- One row per company. Two rows for the same domain is the dedupe bug this
-- list already hit once (Suches Vacation Rentals), so the database refuses it
-- rather than leaving it to the importer. Partial, because most rows that
-- arrive have no domain yet and NULLs must not collide.
CREATE UNIQUE INDEX prospect_accounts_domain_key
  ON public.prospect_accounts (lower(domain))
  WHERE domain IS NOT NULL AND domain <> '';

CREATE INDEX prospect_accounts_status_idx        ON public.prospect_accounts (status);
CREATE INDEX prospect_accounts_track_idx         ON public.prospect_accounts (track);
CREATE INDEX prospect_accounts_pms_idx           ON public.prospect_accounts (pms);
CREATE INDEX prospect_accounts_state_idx         ON public.prospect_accounts (state);
CREATE INDEX prospect_accounts_next_action_idx   ON public.prospect_accounts (next_action_at)
  WHERE next_action_at IS NOT NULL;
CREATE INDEX prospect_accounts_score_a_idx       ON public.prospect_accounts (score_a DESC NULLS LAST);
CREATE INDEX prospect_accounts_score_b_idx       ON public.prospect_accounts (score_b DESC NULLS LAST);

-- Free-text search across the fields the admin page's search box covers, so
-- "hiawassee", "streamline" and "knight" all work without a sequential scan
-- once the list outgrows a few thousand rows.
CREATE INDEX prospect_accounts_search_idx ON public.prospect_accounts
  USING gin (to_tsvector('simple',
    coalesce(company,'')      || ' ' || coalesce(city,'')         || ' ' ||
    coalesce(market,'')       || ' ' || coalesce(pms,'')          || ' ' ||
    coalesce(contact_name,'') || ' ' || coalesce(domain,'')       || ' ' ||
    coalesce(email,'')
  ));

CREATE TRIGGER trg_prospect_accounts_updated_at
  BEFORE UPDATE ON public.prospect_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.prospect_accounts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_accounts TO service_role;

CREATE POLICY "prospect_accounts_admin_select"
  ON public.prospect_accounts FOR SELECT
  USING (is_platform_staff_admin());

CREATE POLICY "prospect_accounts_admin_insert"
  ON public.prospect_accounts FOR INSERT
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "prospect_accounts_admin_update"
  ON public.prospect_accounts FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "prospect_accounts_admin_delete"
  ON public.prospect_accounts FOR DELETE
  USING (is_platform_staff_admin());

COMMENT ON TABLE public.prospect_accounts IS
  'Outbound prospecting funnel — platform-internal go-to-market data, not
   tenant data. No organization_id by design; readable and writable only by
   platform_staff with role = admin via is_platform_staff_admin().';

COMMENT ON COLUMN public.prospect_accounts.email_is_generic IS
  'True when email is a role inbox (info@, reservations@ …) rather than a
   named person. Generated, so it cannot drift from email.';

COMMENT ON COLUMN public.prospect_accounts.pms_note IS
  'How the PMS was determined — the fingerprint, the page it was found on, or
   who confirmed it. Detection is mostly indirect (owner-portal hostnames,
   image CDN paths), so the evidence is worth more than the label.';
