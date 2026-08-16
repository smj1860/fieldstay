-- scripts/rls-isolation-probe.sql
-- ============================================================================
-- DYNAMIC cross-tenant isolation probe. Read-only. Run manually.
--
-- WHAT THIS CATCHES THAT NOTHING ELSE DOES
--
-- db_invariant_report() proves RLS is enabled and every table has policies.
-- check-db-invariants.mjs checks 11-13 prove no policy is blanket-true,
-- unscoped, or missing WITH CHECK. All of those read the policy's SHAPE.
--
-- None of them can catch a policy that is perfectly well-formed and expresses
-- the WRONG RULE — scoped to the wrong column, joined through the wrong
-- relation, or individually correct and defeated by a second permissive policy
-- OR-ed alongside it. The only way to know is to ask the database what a real
-- user can actually see.
--
-- HOW IT WORKS
--
-- Impersonate an authenticated user the way PostgREST does: SET ROLE
-- authenticated, then set request.jwt.claims — which is exactly what
-- auth.uid() reads. Then ask one question per table:
--
--     how many rows belonging to an org this user is NOT a member of are
--     visible to them?
--
-- The correct answer is always 0. Anything else is a live cross-tenant leak.
--
-- SAFE ON PRODUCTION, and production is where it belongs: it is the only
-- database with genuine multi-tenant data, and a probe with no foreign rows to
-- find proves nothing at all. Only SELECT count(*) runs, and only counts come
-- back — never a row, never a column value.
--
-- WHY THIS IS A SCRIPT AND NOT A MIGRATION + CI GATE
--
-- Two Postgres constraints, both found the hard way rather than assumed:
--
--   1. `SET ROLE` is REJECTED inside a SECURITY DEFINER function
--      ("cannot set parameter role within security-definer function"), so the
--      probe cannot be packaged as an RPC that switches role itself.
--   2. Making the function SECURITY DEFINER owned by `authenticated` instead
--      (so ownership does the role switch) fails at creation: `authenticated`
--      has no CREATE on schema public, and granting it that to enable a test
--      harness would be a real privilege escalation. Not worth it.
--
-- So the role switch has to happen in the SESSION, which needs a transport
-- that holds a transaction across statements — psql or a direct Postgres
-- connection. The db-invariants CI job talks to PostgREST, which cannot.
-- Wiring this into CI therefore needs a direct-connection step; until then it
-- is a documented manual audit, which is still strictly more than the zero
-- dynamic coverage that existed before.
--
-- USAGE
--   1. Pick a user and their org:
--        SELECT om.user_id, om.org_id FROM organization_members om
--         WHERE om.invite_accepted_at IS NOT NULL LIMIT 1;
--   2. Substitute both below and run the whole file in one session.
--   3. Read the CONTROL row first — see below.
--
-- READING THE RESULT
--
-- A row of zeros means nothing on its own: an impersonation that silently
-- failed, a missing GRANT, or an empty database all produce zeros too. The
-- CONTROL query is what makes the zeros mean something. It must show:
--
--   running_as     = authenticated   (the role switch took)
--   auth_uid_sees  = the user's id   (the claims took, so policies can match)
--   own_* > 0                        (the user can see their OWN rows, so a
--                                     zero elsewhere is RLS working and not a
--                                     denied grant or a blind query)
--
-- and the GROUND TRUTH query must show foreign rows actually exist to be
-- found. Only with all three does foreign_* = 0 mean isolation.
--
-- Last run 2026-08-15 against production: control passed (own_properties 6,
-- own_turnovers 11, own_bookings 11), ground truth showed 22 foreign
-- properties / 58 turnovers / 49 work_orders / 49 bookings existed, and every
-- foreign count came back 0. First dynamic confirmation of tenant isolation in
-- this codebase.
-- ============================================================================

\set probe_user  'b07cb2b8-bb72-41ad-bd55-8a1c8268c42e'
\set probe_org   '1125e49b-32e8-41a7-8200-e85d4b2f0d25'

BEGIN;

-- ── GROUND TRUTH (as the connecting role, RLS bypassed) ─────────────────────
-- How many foreign-org rows exist at all? A table with none is UNTESTED by the
-- probe below, not passing.
SELECT 'GROUND TRUTH' AS phase, 'properties'  AS tbl, count(*) AS foreign_rows_existing
  FROM properties  WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'GROUND TRUTH','bookings',    count(*) FROM bookings    WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'GROUND TRUTH','turnovers',   count(*) FROM turnovers   WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'GROUND TRUTH','work_orders', count(*) FROM work_orders WHERE org_id <> :'probe_org'::uuid
ORDER BY 3 DESC;

-- ── IMPERSONATE ────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'probe_user', 'role', 'authenticated')::text,
  true);

-- ── CONTROL — read this BEFORE trusting any zero below ──────────────────────
SELECT current_user        AS running_as,
       (SELECT auth.uid()) AS auth_uid_sees,
       (SELECT count(*) FROM properties WHERE org_id  = :'probe_org'::uuid) AS own_properties,
       (SELECT count(*) FROM turnovers  WHERE org_id  = :'probe_org'::uuid) AS own_turnovers,
       (SELECT count(*) FROM bookings   WHERE org_id  = :'probe_org'::uuid) AS own_bookings;

-- ── THE PROBE — every count here must be 0 ──────────────────────────────────
SELECT 'properties' AS tbl, count(*) AS foreign_rows_visible FROM properties WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'bookings',             count(*) FROM bookings             WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'turnovers',            count(*) FROM turnovers            WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'work_orders',          count(*) FROM work_orders          WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'owner_transactions',   count(*) FROM owner_transactions   WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'inventory_items',      count(*) FROM inventory_items      WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'crew_members',         count(*) FROM crew_members         WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'vendors',              count(*) FROM vendors              WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'property_owners',      count(*) FROM property_owners      WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'organization_members', count(*) FROM organization_members WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'notifications',        count(*) FROM notifications        WHERE org_id <> :'probe_org'::uuid
UNION ALL SELECT 'audit_events',         count(*) FROM audit_events         WHERE org_id <> :'probe_org'::uuid
ORDER BY 2 DESC, 1;

-- Nothing is written, but roll back anyway so the role switch and the claims
-- cannot outlive the probe on a pooled connection.
ROLLBACK;
