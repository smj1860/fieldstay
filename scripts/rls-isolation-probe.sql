-- scripts/rls-isolation-probe.sql
-- ============================================================================
-- DYNAMIC cross-tenant isolation probe. Self-asserting. Rolls back everything.
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
-- WHY IT SEEDS A FOREIGN ORG INSTEAD OF HOPING ONE EXISTS
--
-- A count of 0 is the passing answer AND the answer you get from a database
-- with only one tenant in it. The first version of this file was written for
-- production, where that distinction is academic — there are dozens of orgs.
-- Pointed at the E2E project it would have been vacuous: that project has
-- exactly ONE organization, so every count is 0 for reasons that have nothing
-- to do with RLS, and the gate would have been green from the day it was
-- added while proving nothing at all.
--
-- So the probe now MANUFACTURES its own foreign tenant — an org plus one row
-- in each probed table — inside the transaction it rolls back. Ground truth is
-- then non-zero by construction on any database, and the probe means the same
-- thing in CI as it does against production. On production it is additive: the
-- real foreign rows are counted too.
--
-- WHY IT ALSO PLANTS A CANARY
--
-- A blinded probe is indistinguishable from a passing one — a failed role
-- switch, a missing GRANT, or a WHERE clause that matches nothing all produce
-- the same clean row of zeros. So the run also creates one throwaway table
-- with a DELIBERATELY WRONG blanket-true policy and asserts the probe SEES the
-- foreign row in it. If the canary is invisible, the probe is broken and the
-- run fails — rather than reporting that isolation holds.
--
-- SAFE ON PRODUCTION. Everything is inside a single transaction that ends in
-- ROLLBACK: the seeded org, the canary table, the role switch and the JWT
-- claims all cease to exist when the transaction ends. Only counts are
-- selected — never a row, never a column value.
--
-- USAGE
--   bash scripts/run-rls-probe.sh                 # picks the busiest tenant
--   FIELDSTAY_PROBE_USER=<uuid> bash scripts/run-rls-probe.sh
--
-- Or directly:  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f this-file
--
-- Requires a SESSION that can hold a transaction across statements, which is
-- why this is psql over a direct/session-mode connection and not an RPC over
-- PostgREST. Two Postgres constraints rule the RPC out, both found by hitting
-- them rather than assuming:
--
--   1. SET ROLE is REJECTED inside a SECURITY DEFINER function ("cannot set
--      parameter role within security-definer function").
--   2. Owning that function as `authenticated` instead, so ownership does the
--      switch, fails at creation: `authenticated` has no CREATE on schema
--      public, and granting it that to enable a test harness would be a real
--      privilege escalation.
--
-- READING THE RESULT
--
-- The run FAILS (non-zero exit) on any of: no impersonatable user, a seed that
-- did not land, a blind canary, an invisible own-org row, or any foreign row
-- visible. A pass prints one row per table per phase:
--
--   ground_truth  — foreign rows that EXIST. Always >= 1; the seed guarantees it.
--   foreign_seen  — foreign rows VISIBLE to the probe user. Must be 0.
--   canary        — the deliberately-leaky negative control. Must be >= 1,
--                   or the probe is blind and every zero above is unmeasured.
--   own_control   — the seeded own-org row. Must be >= 1, or RLS is denying
--                   legitimate access and the zeros mean nothing either.
--   own           — the probe user's own rows per table. INFORMATIONAL only:
--                   a real tenant legitimately has zero vendors or zero
--                   bookings, so nothing is asserted against these.
-- ============================================================================

BEGIN;

-- ── The tables under probe, defined ONCE ────────────────────────────────────
-- Both loops below read this list, so a table can never be seeded-but-unprobed
-- or probed-but-unseeded.
CREATE TEMP TABLE probe_tables (tbl text PRIMARY KEY);
INSERT INTO probe_tables (tbl) VALUES
  ('properties'), ('bookings'), ('turnovers'), ('work_orders'),
  ('owner_transactions'), ('inventory_items'), ('crew_members'), ('vendors'),
  ('property_owners'), ('organization_members'), ('notifications'),
  ('audit_events');

-- ── Who we impersonate ──────────────────────────────────────────────────────
-- Resolved from the data, not hardcoded, so this file is portable across
-- projects and cannot rot when a fixture user is deleted. Busiest org first:
-- the control check is only meaningful for a user who owns some rows.
--
-- FIELDSTAY_PROBE_USER (passed through as a GUC by run-rls-probe.sh) pins a
-- specific user when you are investigating one tenant.
CREATE TEMP TABLE probe_target AS
SELECT om.user_id AS usr, om.org_id AS org
  FROM organization_members om
  JOIN LATERAL (
    SELECT count(*) AS n FROM properties p WHERE p.org_id = om.org_id
  ) c ON TRUE
 WHERE om.user_id IS NOT NULL
   AND om.invite_accepted_at IS NOT NULL
   -- Compared as TEXT, and the unset case defaults to the row's own value
   -- rather than being guarded by an OR. Postgres does not guarantee
   -- short-circuit evaluation of OR, so the obvious spelling
   -- (`… IS NULL OR om.user_id = current_setting(…)::uuid`) still evaluates
   -- the cast when the GUC is an empty string and dies with 22P02 on a run
   -- that was supposed to auto-select. Nothing here can throw.
   AND om.user_id::text = coalesce(
     nullif(current_setting('fieldstay.probe_user', true), ''),
     om.user_id::text
   )
 ORDER BY c.n DESC, om.org_id, om.user_id
 LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM probe_target) THEN
    RAISE EXCEPTION
      'PROBE ABORTED: no accepted organization_members row to impersonate. '
      'Without a real user there is nothing to measure, and reporting zeros '
      'here would be the vacuous pass this probe exists to prevent.';
  END IF;
END $$;

-- ── Seed the OWN side ───────────────────────────────────────────────────────
-- The positive control, and it is seeded for the same reason the negative one
-- is. The E2E project's tenant data is created and torn down by the Playwright
-- suite, so "how many of their own rows does this user see" answered 1 and
-- then 0 within a minute while this file was being written. An assertion on
-- ambient data would have gone red on a run with no defect in it, and a
-- watchdog that cries wolf gets muted.
--
-- notifications because its SELECT policy is plain org membership
-- (org_id IN get_user_org_ids()), so every accepted member of any role must
-- see this row. If they cannot, RLS is denying legitimate access — a real
-- finding, and one the foreign-row half of this probe cannot see.
INSERT INTO notifications (org_id, type, title, href)
SELECT org, 'rls_probe_own', 'rls-probe own-org control', '/' FROM probe_target;

-- ── Seed a foreign tenant ───────────────────────────────────────────────────
-- One org, one property, one row per probed table. Rolled back with everything
-- else. See the header for why hoping for foreign rows is not good enough.
CREATE TEMP TABLE probe_foreign AS
SELECT gen_random_uuid() AS org, gen_random_uuid() AS prop;

INSERT INTO organizations (id, name, slug, max_properties)
SELECT org, 'rls-probe foreign org', 'rls-probe-' || org, 1000 FROM probe_foreign;

INSERT INTO properties (id, org_id, name)
SELECT prop, org, 'rls-probe foreign property' FROM probe_foreign;

INSERT INTO bookings (property_id, org_id, checkin_date, checkout_date)
SELECT prop, org, current_date, current_date + 1 FROM probe_foreign;

INSERT INTO turnovers (property_id, org_id, checkout_datetime, checkin_datetime)
SELECT prop, org, now(), now() + interval '1 day' FROM probe_foreign;

INSERT INTO work_orders (property_id, org_id, title)
SELECT prop, org, 'rls-probe foreign work order' FROM probe_foreign;

INSERT INTO owner_transactions (property_id, org_id, transaction_type, amount, description, transaction_date)
SELECT prop, org, 'expense'::txn_type, 1, 'rls-probe', current_date FROM probe_foreign;

INSERT INTO inventory_items (property_id, org_id, name)
SELECT prop, org, 'rls-probe foreign item' FROM probe_foreign;

INSERT INTO property_owners (org_id, property_id, name)
SELECT org, prop, 'rls-probe foreign owner' FROM probe_foreign;

INSERT INTO crew_members (org_id, name)
SELECT org, 'rls-probe foreign crew' FROM probe_foreign;

INSERT INTO vendors (org_id, name)
SELECT org, 'rls-probe foreign vendor' FROM probe_foreign;

INSERT INTO notifications (org_id, type, title, href)
SELECT org, 'rls_probe', 'rls-probe foreign notification', '/' FROM probe_foreign;

INSERT INTO audit_events (org_id, action)
SELECT org, 'security.route.mismatch' FROM probe_foreign;

-- user_id NULL on purpose: this is a membership of the FOREIGN org, and
-- attaching it to a real auth.users row is both unnecessary and a way to make
-- the probe's own fixture visible to someone.
INSERT INTO organization_members (org_id, role)
SELECT org, 'admin'::member_role FROM probe_foreign;

-- ── The canary ──────────────────────────────────────────────────────────────
-- DELIBERATELY BROKEN, and that is the point. A blanket-true SELECT policy is
-- precisely what checks 11-13 forbid in a migration; here it is the negative
-- control that proves the probe below can still SEE a leak. Created inside the
-- rolled-back transaction, so it never exists to any other connection.
CREATE TABLE public.rls_probe_canary (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL
);
ALTER TABLE public.rls_probe_canary ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_probe_canary_select ON public.rls_probe_canary FOR SELECT USING (true);
GRANT SELECT ON public.rls_probe_canary TO authenticated;
INSERT INTO public.rls_probe_canary (org_id) SELECT org FROM probe_foreign;

-- ── Ground truth, measured while RLS is still bypassed ───────────────────────
CREATE TEMP TABLE probe_results (
  phase text,
  tbl   text,
  n     bigint,
  PRIMARY KEY (phase, tbl)
);

DO $$
DECLARE
  v_org uuid := (SELECT org FROM probe_target);
  v_tbl text;
  v_n   bigint;
BEGIN
  FOR v_tbl IN SELECT tbl FROM probe_tables ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE org_id <> $1', v_tbl)
      INTO v_n USING v_org;
    INSERT INTO probe_results VALUES ('ground_truth', v_tbl, v_n);

    IF v_n = 0 THEN
      RAISE EXCEPTION
        'PROBE ABORTED: no foreign rows exist in %, so a zero there would '
        'prove nothing. The seed above should have guaranteed at least one — '
        'this means the seed did not land.', v_tbl;
    END IF;
  END LOOP;
END $$;

-- After SET ROLE, the session can no longer read its own temp tables without
-- these ("permission denied for table probe_target"). Temp schema, so they
-- disappear with the transaction.
GRANT SELECT          ON probe_tables, probe_target, probe_foreign TO authenticated;
GRANT SELECT, INSERT  ON probe_results TO authenticated;

-- ── Impersonate ─────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT usr FROM probe_target), 'role', 'authenticated')::text,
  true);

-- ── Control, canary and probe — one pass, so the report and the assertions
--    can never disagree about what was measured ────────────────────────────
DO $$
DECLARE
  v_org      uuid   := (SELECT org FROM probe_target);
  v_usr      uuid   := (SELECT usr FROM probe_target);
  v_tbl      text;
  v_n        bigint;
  v_own_total bigint := 0;
  v_leaks    text[]  := '{}';
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'PROBE ABORTED: impersonation failed, still running as %.', current_user;
  END IF;

  IF (SELECT auth.uid()) IS DISTINCT FROM v_usr THEN
    RAISE EXCEPTION
      'PROBE ABORTED: auth.uid() is %, expected %. Policies match on auth.uid(), '
      'so every count below would be measuring the wrong user.',
      coalesce((SELECT auth.uid())::text, 'NULL'), v_usr;
  END IF;

  -- The canary must be VISIBLE. If it is not, the probe cannot see a leak it
  -- was handed on a plate, and the zeros below mean nothing.
  SELECT count(*) INTO v_n FROM public.rls_probe_canary WHERE org_id <> v_org;
  INSERT INTO probe_results VALUES ('canary', 'rls_probe_canary', v_n);
  IF v_n = 0 THEN
    RAISE EXCEPTION
      'PROBE ABORTED: the canary table has a blanket-true SELECT policy and a '
      'foreign row, and the probe cannot see it. The probe is BLIND — treat '
      'every zero in this run as unmeasured, not as passing.';
  END IF;

  FOR v_tbl IN SELECT tbl FROM probe_tables ORDER BY tbl LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE org_id = $1', v_tbl)
      INTO v_n USING v_org;
    INSERT INTO probe_results VALUES ('own', v_tbl, v_n);
    v_own_total := v_own_total + v_n;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE org_id <> $1', v_tbl)
      INTO v_n USING v_org;
    INSERT INTO probe_results VALUES ('foreign_seen', v_tbl, v_n);
    IF v_n > 0 THEN
      v_leaks := v_leaks || format('%s (%s rows)', v_tbl, v_n);
    END IF;
  END LOOP;

  -- The positive control, asserted against the row we SEEDED rather than
  -- against whatever ambient data happens to exist. A denied grant, a failed
  -- claim, or an over-restrictive policy all land here — and any of them would
  -- make every foreign zero above meaningless.
  SELECT count(*) INTO v_n
    FROM notifications WHERE org_id = v_org AND type = 'rls_probe_own';
  INSERT INTO probe_results VALUES ('own_control', 'notifications', v_n);
  IF v_n = 0 THEN
    RAISE EXCEPTION
      'PROBE ABORTED: user % cannot see a row seeded into their OWN org '
      '(notifications, whose SELECT policy is plain org membership). That is a '
      'denied grant or a broken claim, not proof of isolation — and if it is '
      'neither, it is RLS denying legitimate access.', v_usr;
  END IF;

  IF array_length(v_leaks, 1) > 0 THEN
    RAISE EXCEPTION
      'CROSS-TENANT LEAK: user % can read rows belonging to another org in: %',
      v_usr, array_to_string(v_leaks, ', ');
  END IF;

  RAISE NOTICE 'RLS isolation probe PASSED: % tables, 0 foreign rows visible, % own rows visible.',
    (SELECT count(*) FROM probe_tables), v_own_total;
END $$;

-- The report. Counts only — never a row, never a column value.
SELECT phase, tbl, n
  FROM probe_results
 ORDER BY phase ASC, tbl ASC;

-- Nothing may survive: not the seeded org, not the canary table, not the role
-- switch, not the claims.
ROLLBACK;
