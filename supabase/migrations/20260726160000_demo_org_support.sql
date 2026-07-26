-- Roadshow demo support (OwnerRez Gulf Shores, Aug 3).
--
-- The demo tenant is an ORDINARY org inside the production project, marked
-- with is_demo. It is deliberately NOT a Supabase branch and NOT an RLS
-- bypass: it goes through the same get_user_org_ids()/is_org_member() path
-- as every other tenant, so demoing can never exercise a code path that
-- real customers don't. The flag exists for exactly two purposes:
--   1. Route guest/vendor-facing side effects (SMS, guest email, payouts)
--      into demo_activity_log instead of the real provider — seeded contact
--      info is fake, and a bounced email or misdirected text mid-demo is
--      both embarrassing and a deliverability problem.
--   2. Scope the one-tap reset/reseed so it can never touch a real org.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Partial index: the only query shape is "find the demo org(s)", and in
-- production this predicate matches exactly one row out of every org.
CREATE INDEX IF NOT EXISTS idx_organizations_is_demo
  ON organizations (is_demo) WHERE is_demo = true;

-- ── demo_activity_log ──────────────────────────────────────────────────────
-- Append-only record of every side effect that WOULD have fired for the demo
-- org but was simulated instead. Doubles as demo content: the booth UI reads
-- this back to show "SMS delivered to vendor" without a real message existing.
CREATE TABLE IF NOT EXISTS demo_activity_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- org_id, not organization_id — every other org-scoped table in this schema
  -- uses org_id, and get_user_org_ids()/is_org_member() call sites assume it.
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  simulated_at  timestamptz NOT NULL DEFAULT now()
);

-- Covering index for the org_id FK (db-invariants FK-coverage gate) that also
-- serves the only read query: this org's activity, newest first.
CREATE INDEX IF NOT EXISTS idx_demo_activity_log_org_simulated_at
  ON demo_activity_log (org_id, simulated_at DESC);

ALTER TABLE demo_activity_log ENABLE ROW LEVEL SECURITY;

-- Postgres checks the GRANT before RLS ever evaluates — without this the
-- table throws "permission denied" on every query no matter how correct the
-- policies are (see 20260710200000_grant_authenticated_missing_tables.sql).
-- SELECT only, and no anon grant: writes are service-role exclusively (the
-- simulateOrSend wrapper), and nothing reads this unauthenticated.
GRANT SELECT ON demo_activity_log TO authenticated;

DROP POLICY IF EXISTS demo_activity_log_select ON demo_activity_log;
CREATE POLICY demo_activity_log_select
  ON demo_activity_log FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- No INSERT/UPDATE/DELETE policy by design. Rows are written only by the
-- service-role client inside lib/demo/simulate.ts, which bypasses RLS; the
-- log is append-only from the application's point of view and must not be
-- editable by a session that merely belongs to the demo org.
