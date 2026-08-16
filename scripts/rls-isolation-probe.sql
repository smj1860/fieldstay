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
-- WHY A SCRIPT AND NOT AN RPC + CI GATE
--
-- Two Postgres constraints, both found by hitting them rather than assuming:
--
--   1. SET ROLE is REJECTED inside a SECURITY DEFINER function ("cannot set
--      parameter role within security-definer function"), so the probe cannot
--      package itself as an RPC that switches role.
--   2. Owning that function as `authenticated` instead, so ownership does the
--      switch, fails at creation: `authenticated` has no CREATE on schema
--      public, and granting it that to enable a test harness would be a real
--      privilege escalation.
--
-- So the role switch has to happen in the SESSION, which needs a transport
-- that holds a transaction across statements. The db-invariants CI job talks
-- to PostgREST, which cannot. Gating this needs a direct-connection CI step;
-- until then it is a documented manual audit, which is still strictly more
-- than the zero dynamic coverage that came before.
--
-- USAGE
--   1. Pick a user and their org:
--        SELECT om.user_id, om.org_id FROM organization_members om
--         WHERE om.invite_accepted_at IS NOT NULL LIMIT 1;
--   2. Put both in the probe_target INSERT below — the ONLY place they appear.
--   3. Run the whole file in ONE session/transaction.
--
-- Deliberately plain SQL: no psql \set or :'var' meta-commands, so this runs
-- in any client that can hold a transaction, and the two ids are defined
-- exactly once instead of being repeated per query.
--
-- READING THE RESULT
--
-- A row of zeros means NOTHING on its own: a failed impersonation, a missing
-- GRANT, or an empty database all produce zeros too. Two other outputs are
-- what make the zeros mean something, and both must be checked first.
--
--   CONTROL must show   running_as = authenticated
--                       auth_uid   = the user's id (so policies can match)
--                       own_* > 0  (the user sees their OWN rows, so a zero
--                                   elsewhere is RLS working — not a denied
--                                   grant and not a blind query)
--   GROUND TRUTH must show foreign rows actually EXIST to be found. A table
--   with 0 there is UNTESTED by this probe, not passing.
--
-- Last run 2026-08-15 against production: control passed (own_properties 6,
-- own_turnovers 11, own_bookings 11), ground truth showed 22 foreign
-- properties / 58 turnovers / 49 bookings / 29 work_orders existed, and every
-- foreign count came back 0. First dynamic confirmation of tenant isolation in
-- this codebase.
-- ============================================================================

BEGIN;

-- The probe identity, defined ONCE. Everything below reads it from here.
CREATE TEMP TABLE probe_target AS
SELECT 'b07cb2b8-bb72-41ad-bd55-8a1c8268c42e'::uuid AS usr,
       '1125e49b-32e8-41a7-8200-e85d4b2f0d25'::uuid AS org;

-- Required: after SET ROLE below, the session can no longer read its own temp
-- table without this ("permission denied for table probe_target"). Temp
-- schema, so it disappears with the session.
GRANT SELECT ON probe_target TO authenticated;

-- ── GROUND TRUTH (still the connecting role, RLS bypassed) ──────────────────
-- How many foreign-org rows exist at all? This is what makes a 0 below
-- meaningful rather than vacuous.
SELECT 'properties' AS tbl, count(*) AS foreign_rows_existing
  FROM properties WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'bookings',    count(*) FROM bookings    WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'turnovers',   count(*) FROM turnovers   WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'work_orders', count(*) FROM work_orders WHERE org_id <> (SELECT org FROM probe_target)
ORDER BY foreign_rows_existing DESC, tbl ASC;

-- ── IMPERSONATE ─────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT usr FROM probe_target), 'role', 'authenticated')::text,
  true);

-- ── CONTROL — read this BEFORE trusting any zero below ──────────────────────
SELECT current_user        AS running_as,
       (SELECT auth.uid()) AS auth_uid_sees,
       (SELECT count(*) FROM properties WHERE org_id = (SELECT org FROM probe_target)) AS own_properties,
       (SELECT count(*) FROM turnovers  WHERE org_id = (SELECT org FROM probe_target)) AS own_turnovers,
       (SELECT count(*) FROM bookings   WHERE org_id = (SELECT org FROM probe_target)) AS own_bookings;

-- ── THE PROBE — every count here must be 0 ──────────────────────────────────
SELECT 'properties' AS tbl, count(*) AS foreign_rows_visible
  FROM properties WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'bookings',             count(*) FROM bookings             WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'turnovers',            count(*) FROM turnovers            WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'work_orders',          count(*) FROM work_orders          WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'owner_transactions',   count(*) FROM owner_transactions   WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'inventory_items',      count(*) FROM inventory_items      WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'crew_members',         count(*) FROM crew_members         WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'vendors',              count(*) FROM vendors              WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'property_owners',      count(*) FROM property_owners      WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'organization_members', count(*) FROM organization_members WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'notifications',        count(*) FROM notifications        WHERE org_id <> (SELECT org FROM probe_target)
UNION ALL SELECT 'audit_events',         count(*) FROM audit_events         WHERE org_id <> (SELECT org FROM probe_target)
ORDER BY foreign_rows_visible DESC, tbl ASC;

-- Nothing is written, but roll back anyway so the role switch, the claims and
-- the temp grant cannot outlive the probe on a pooled connection.
ROLLBACK;
