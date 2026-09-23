-- RECONSTRUCTED FROM PRODUCTION, NOT A NEW CHANGE.
--
-- public.str_prospects was applied to production on 2026-09-19 through MCP
-- apply_migration with no migration file committed alongside it — the exact
-- drift scripts/check-migration-ledger.mjs exists to catch, and the reason
-- production's baseline entry is empty ("anything appearing here again is new
-- drift"). The objects are real and hold 845 rows; what was missing was the
-- repo's ability to reproduce them. This file and its sibling
-- 20260919155038_create_str_prospects_icp_view.sql are that reproduction,
-- written from the live definitions (pg_get_constraintdef / pg_get_triggerdef
-- / information_schema) rather than from memory, and carry the two ledger
-- versions already recorded so the parity check matches them up.
--
-- Everything is IF NOT EXISTS / OR REPLACE: production already has all of it,
-- so this file must be a no-op there while still building the objects from
-- scratch on a project that does not (the E2E project, a local reset).
--
-- ── WHY THERE ARE NO RLS POLICIES ───────────────────────────────────────────
--
-- Deliberate, and recorded in the table's own COMMENT below: RLS is ON with
-- ZERO policies, which denies every client, and only service_role holds a
-- grant. That is the same deny-all stance as promo_hospitable_launch_counter
-- and integration_entity_owners. The strscout scraper writes it with the
-- service role and nothing in the app reads it, so there is no client query
-- for a policy to permit. Adding one would widen access to a table nobody is
-- supposed to reach — do not "fix" the empty policy list.
--
-- str_prospects is a SEPARATE list from prospect_accounts (the /admin/prospects
-- funnel): different source, different key, no FK between them.

CREATE TABLE IF NOT EXISTS public.str_prospects (
  dedupe_key        text PRIMARY KEY,
  name              text NOT NULL,
  name_canonical    text,
  kind              text,
  state             text,
  city              text,
  website           text,
  domain            text,
  phone             text,
  email             text,
  address           text,
  property_count    integer DEFAULT 0,
  properties_sample text,
  confidence        integer DEFAULT 0,
  source            text,
  source_detail     text,
  evidence_url      text,
  first_seen        date,
  last_seen         date,
  status            text DEFAULT 'new',
  pms               text,
  owner_notes       text,
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS str_prospects_name_idx   ON public.str_prospects (name_canonical);
CREATE INDEX IF NOT EXISTS str_prospects_state_idx  ON public.str_prospects (state);
CREATE INDEX IF NOT EXISTS str_prospects_status_idx ON public.str_prospects (status);
CREATE INDEX IF NOT EXISTS str_prospects_conf_idx   ON public.str_prospects (confidence DESC);
CREATE INDEX IF NOT EXISTS str_prospects_count_idx  ON public.str_prospects (property_count DESC);

-- Its own toucher rather than the shared public.set_updated_at(): that is what
-- production has, and matching it is the point of this file.
CREATE OR REPLACE FUNCTION public.str_prospects_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

DROP TRIGGER IF EXISTS str_prospects_touch ON public.str_prospects;
CREATE TRIGGER str_prospects_touch
  BEFORE UPDATE ON public.str_prospects
  FOR EACH ROW EXECUTE FUNCTION public.str_prospects_touch_updated_at();

ALTER TABLE public.str_prospects ENABLE ROW LEVEL SECURITY;

-- No policies, and no grant to anon or authenticated. See the header.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.str_prospects TO service_role;

COMMENT ON TABLE public.str_prospects IS
  'Outbound prospect list from the strscout scraper. RLS enabled with no policies by design - service_role only (the scraper upserts on dedupe_key). Scraper payloads never include status/pms/owner_notes, so manual edits survive refreshes.';
