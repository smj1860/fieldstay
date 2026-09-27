-- scripts/rls-plan-probe.sql
-- ============================================================================
-- RLS QUERY-PLAN probe at multi-tenant volume. Self-asserting. Rolls back.
--
-- WHAT THIS ANSWERS THAT NOTHING ELSE DOES
--
-- CLAUDE.md's Manual Audit Checklist carries one item it explicitly refuses to
-- lint: the standard `is_org_member(...)` / `org_id IN (SELECT
-- get_user_org_ids())` policy is opaque to the planner, so a large table's
-- RLS-filtered scan CAN fall back to evaluating that function once per
-- candidate row instead of seeking an index on org_id. Whether it actually
-- does is plan-dependent and volume-dependent, so the checklist says to run
-- EXPLAIN ANALYZE by hand, table by table, and read the plan.
--
-- That instruction was never carried out, because doing it needs data this
-- platform did not have yet: the E2E project holds ONE org and ONE property,
-- and a plan measured against one row tells you nothing about the plan you
-- get against a 334-property tenant sharing tables with thirteen others.
--
-- So this file MANUFACTURES that platform, measures the real dashboard reads
-- against it, and asserts on the plan shape. It is the mechanical half of a
-- check the checklist describes as manual — it does not replace reading the
-- plans (the runner prints them), it stops the reading from being optional.
--
-- WHY THE PLAN SHAPE, NOT THE TIMING
--
-- Execution time on a seeded fixture is not production's execution time:
-- different hardware, cold caches, no concurrency. What DOES carry over is
-- the SHAPE — whether the planner seeks an index on org_id or scans the table
-- calling a SECURITY DEFINER function per row. A seek that is fast here is
-- fast there; a per-row function call that is survivable here at 6,000 rows
-- is not survivable at 60,000. So every assertion below is about shape, and
-- the timings are printed as context rather than gated on.
--
-- THE PORTFOLIO IT SEEDS
--
--   1 org x 334 properties   (the large account)
--   3 orgs x  90             (70-110 band)
--   4 orgs x  40             (30-50 band)
--   6 orgs x  18             (12-25 band)
--   = 872 properties across 14 orgs
--
-- Ratios per property are the live figures recorded in CLAUDE.md: 18 active
-- maintenance schedules, 9 assets. The point of seeding the OTHER thirteen
-- tenants is that RLS scan cost tracks TOTAL table size, not one tenant's
-- share of it — the large account's rows are ~38% of the table, so measuring
-- it alone would understate every plan.
--
-- WHY IT ALSO PLANTS A CANARY
--
-- Same reason rls-isolation-probe.sql does. "No sequential scan found" is the
-- passing answer AND the answer you get from a check that is looking for the
-- wrong string, parsing a plan that failed to generate, or measuring a table
-- that was never seeded. So the run re-measures one query with
-- enable_indexscan off and REQUIRES the check to fail on it. If the canary
-- passes, the probe cannot tell a good plan from a bad one and the run aborts
-- rather than reporting healthy plans.
--
-- SAFE ANYWHERE. Everything — the seeded orgs, the raised max_properties, the
-- role switch, the JWT claims, the ANALYZE — is inside one transaction that
-- ends in ROLLBACK.
--
-- Two notes on running it against PRODUCTION, where it is safe but rarely
-- what you want:
--   1. It seeds ~40k rows and ANALYZEs six tables. Both roll back, but the
--      write churn and the transient statistics are real while it runs.
--   2. Production already HAS volume. There, the useful measurement is the
--      same EXPLAIN against real rows with no seed at all — this file's
--      seeding exists because E2E is empty.
--
-- USAGE
--   bash scripts/run-plan-probe.sh
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/rls-plan-probe.sql
--
-- READING THE RESULT
--
-- One row per probed query:
--   seeks_index — the probed table is reached by an index whose condition
--                     is org_id. This is the assertion.
--   exec_ms         — context only, see above.
--   plan            — the full plan, for the manual read the checklist wants.
-- ============================================================================

BEGIN;

-- ── Who we impersonate ──────────────────────────────────────────────────────
-- Resolved from data rather than hardcoded, same as rls-isolation-probe.sql.
-- The seeded 334-property portfolio is attached to THIS user's org, so the
-- plans measured are the ones the large account's own dashboard produces.
CREATE TEMP TABLE plan_tgt AS
  SELECT user_id AS usr, org_id AS org
    FROM organization_members
   WHERE user_id IS NOT NULL AND invite_accepted_at IS NOT NULL
   ORDER BY org_id, user_id
   LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_tgt) THEN
    RAISE EXCEPTION
      'PROBE ABORTED: no accepted organization_members row to impersonate. '
      'Plans would be measured with auth.uid() NULL, which takes a different '
      'RLS branch than any real user and would prove nothing.';
  END IF;
END $$;

-- properties carries a BEFORE INSERT trigger (enforce_property_plan_limit)
-- that reads organizations.max_properties, so the seed below is refused at
-- the database level without this. Worth knowing outside this file too: the
-- property cap is enforced in Postgres, not only in properties/actions.ts, so
-- onboarding a large account means raising this column or every insert fails.
UPDATE organizations SET max_properties = 2000 WHERE id = (SELECT org FROM plan_tgt);

-- ── Seed the portfolio ──────────────────────────────────────────────────────
CREATE TEMP TABLE plan_portfolio(org uuid, n int, label text);
INSERT INTO plan_portfolio SELECT org, 334, 'big334' FROM plan_tgt;

WITH spec(n, label, cnt) AS (VALUES (90,'mid90',3), (40,'mid40',4), (18,'small18',6)),
ins AS (
  INSERT INTO organizations (id, name, slug, max_properties)
  SELECT gen_random_uuid(),
         'plan probe org ' || s.label || ' ' || g,
         'plan-probe-' || s.label || '-' || g || '-' || floor(random() * 1e9)::text,
         2000
    FROM spec s, generate_series(1, s.cnt) g
  RETURNING id, name
)
INSERT INTO plan_portfolio(org, n, label)
SELECT i.id, s.n, s.label
  FROM ins i JOIN spec s ON i.name LIKE 'plan probe org ' || s.label || ' %';

CREATE TEMP TABLE plan_props AS
  SELECT gen_random_uuid() AS id, p.org, g AS idx
    FROM plan_portfolio p, generate_series(1, p.n) g;

INSERT INTO properties (id, org_id, name, is_active)
  SELECT id, org, 'plan probe property ' || idx, true FROM plan_props;

-- 18 active schedules per property — the live ratio CLAUDE.md records.
INSERT INTO maintenance_schedules (org_id, property_id, name, is_active, next_due_date)
  SELECT pp.org, pp.id, 'plan probe schedule ' || s, true, current_date + (s % 60)
    FROM plan_props pp, generate_series(1, 18) s;

-- 9 assets per property — the live average. Nine DISTINCT asset_types because
-- property_assets carries UNIQUE (property_id, asset_type) WHERE is_active.
INSERT INTO property_assets (org_id, property_id, name, asset_type, is_active)
  SELECT pp.org, pp.id, 'plan probe asset ' || s,
         (ARRAY['hvac','water_heater','roof','refrigerator','washer',
                'dryer','dishwasher','microwave','oven_range']::asset_type[])[s],
         true
    FROM plan_props pp, generate_series(1, 9) s;

INSERT INTO work_orders (org_id, property_id, title, status)
  SELECT pp.org, pp.id, 'plan probe work order ' || s,
         (ARRAY['pending','assigned']::wo_status[])[s]
    FROM plan_props pp, generate_series(1, 2) s;

-- Eight turnovers per property across the board's own 67-day window, so the
-- windowed reads are measured against a window that actually contains rows.
INSERT INTO turnovers (org_id, property_id, checkout_datetime, checkin_datetime, status)
  SELECT pp.org, pp.id,
         now() - interval '7 days' + (s * interval '8 days'),
         now() - interval '7 days' + (s * interval '8 days') + interval '6 hours',
         'pending_assignment'::turnover_status
    FROM plan_props pp, generate_series(1, 8) s;

INSERT INTO bookings (org_id, property_id, checkin_date, checkout_date, status)
  SELECT pp.org, pp.id,
         current_date - 7 + (s * 8), current_date - 7 + (s * 8) + 5,
         'confirmed'::booking_status
    FROM plan_props pp, generate_series(1, 8) s;

-- ── The crew side ───────────────────────────────────────────────────────────
-- checklist_instances / _items and a CREW principal, because the crew branch
-- of those policies is the half a PM probe cannot reach.
--
-- checklist_instance_items' policy has no org_id path at all — both halves go
-- through `instance_id IN (subquery)` — and the table carries no org_id index.
-- On the PM plans every one of those subplans reports `(never executed)`: the
-- PM's own org_id test satisfies the OR first and short-circuits the rest. So
-- measuring this branch needs a user who is a crew member and NOT an org
-- member, which is why an auth.users row is minted here rather than reusing
-- plan_tgt's. Everything rolls back, auth.users included.
CREATE TEMP TABLE plan_instances AS
  SELECT gen_random_uuid() AS id, t.org_id, t.id AS turnover_id
    FROM turnovers t
   WHERE t.org_id = (SELECT org FROM plan_tgt);

INSERT INTO checklist_instances (id, org_id, turnover_id, template_snapshot)
  SELECT id, org_id, turnover_id, '{}'::jsonb FROM plan_instances;

-- 30 items per checklist — the 30-60 range chunked.ts' header cites.
INSERT INTO checklist_instance_items (instance_id, turnover_id, section_name, task, is_completed)
  SELECT ci.id, ci.turnover_id, 'Kitchen', 'plan probe task ' || s, false
    FROM plan_instances ci, generate_series(1, 30) s;

CREATE TEMP TABLE plan_crew AS SELECT gen_random_uuid() AS usr, gen_random_uuid() AS crew;

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  SELECT usr, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'plan-probe-crew@example.invalid', '', now(), now()
    FROM plan_crew;

INSERT INTO crew_members (id, org_id, name, user_id, is_active)
  SELECT crew, (SELECT org FROM plan_tgt), 'plan probe crew', usr, true FROM plan_crew;

-- 800 assigned turnovers: a working cleaner's live scope, and enough that the
-- crew subquery has to materialise something rather than folding to one row.
INSERT INTO turnover_assignments (turnover_id, crew_member_id, org_id)
  SELECT t.id, (SELECT crew FROM plan_crew), (SELECT org FROM plan_tgt)
    FROM (SELECT id FROM turnovers
           WHERE org_id = (SELECT org FROM plan_tgt) ORDER BY id LIMIT 800) t;

INSERT INTO assignment_outcomes (org_id, turnover_id, crew_member_id, pm_rating)
  SELECT (SELECT org FROM plan_tgt), t.id, (SELECT crew FROM plan_crew), 4
    FROM (SELECT id FROM turnovers
           WHERE org_id = (SELECT org FROM plan_tgt) ORDER BY id LIMIT 800) t;

-- Without this every plan below is chosen from default statistics on a table
-- the planner still believes is empty, which is a different planner input than
-- production has and therefore a different plan. ANALYZE inside a transaction
-- is allowed and its pg_statistic rows roll back with everything else.
ANALYZE properties, maintenance_schedules, property_assets, work_orders, turnovers, bookings,
        checklist_instances, checklist_instance_items, crew_members, turnover_assignments,
        assignment_outcomes;

-- ── The queries under probe ─────────────────────────────────────────────────
-- Each mirrors a real dashboard read, including the `.eq('org_id', …)` the
-- application itself applies. That filter is the load-bearing part of the
-- answer: it is what the planner can turn into an index condition, leaving the
-- RLS predicate as a cheap post-filter rather than the thing driving the scan.
-- A read that omitted it and leaned on RLS alone is the case this probe would
-- catch, so the queries must keep it exactly as the app writes it.
-- `expect_cond` is per-query on purpose. Not every probed read is scoped by
-- org_id: the turnover-detail page reads assignment_outcomes by turnover_id,
-- and the crew PWA reads checklist_instance_items by turnover_id, so a single
-- hardcoded org_id assertion would fail on two correct plans. `run_as` picks
-- the principal, because the crew branch of those policies is unreachable as
-- a PM.
CREATE TEMP TABLE plan_queries(
  name        text PRIMARY KEY,
  tbl         text NOT NULL,
  run_as      text NOT NULL CHECK (run_as IN ('pm','crew')),
  -- NOT NULL is load-bearing, not tidiness. seeks_index is computed as
  -- `buf ~ q.expect_cond`, and in SQL `anything ~ NULL` is NULL, not false —
  -- so a row that lost its expect_cond would store seeks_index = NULL and the
  -- final `NOT seeks_index` filter would not select it (NULL is not true).
  -- The probe would report a clean pass for a query it never actually
  -- checked. The guard below catches the same thing from the other side.
  expect_cond text NOT NULL CHECK (expect_cond <> ''),
  sql         text NOT NULL
);

CREATE TEMP TABLE plan_results(
  name           text PRIMARY KEY,
  tbl            text,
  seeks_index boolean,
  exec_ms         numeric,
  plan            text
);

DO $$
DECLARE v_org uuid := (SELECT org FROM plan_tgt);
BEGIN
  INSERT INTO plan_queries(name, tbl, run_as, expect_cond, sql) VALUES
    ('1_maintenance_board_work_orders', 'work_orders', 'pm', 'Index Cond: \(+org_id', format(
      'SELECT id FROM work_orders WHERE org_id=%L '
      'AND status IN (''pending'',''quote_requested'',''assigned'',''in_progress'') '
      'ORDER BY created_at DESC, id LIMIT 999', v_org)),
    ('2_maintenance_board_schedules', 'maintenance_schedules', 'pm', 'Index Cond: \(+org_id', format(
      'SELECT id FROM maintenance_schedules WHERE org_id=%L AND is_active '
      'ORDER BY next_due_date ASC NULLS LAST, id LIMIT 999', v_org)),
    ('3_maintenance_board_assets', 'property_assets', 'pm', 'Index Cond: \(+org_id', format(
      'SELECT id FROM property_assets WHERE org_id=%L AND is_active '
      'ORDER BY name, id LIMIT 999', v_org)),
    ('4_turnovers_board_window', 'turnovers', 'pm', 'Index Cond: \(+org_id', format(
      'SELECT id FROM turnovers WHERE org_id=%L AND status <> ''cancelled'' '
      'AND checkout_datetime >= now() - interval ''7 days'' '
      'AND checkout_datetime <= now() + interval ''60 days'' '
      'ORDER BY checkout_datetime, id LIMIT 999', v_org)),
    ('5_ops_bookings_window', 'bookings', 'pm', 'Index Cond: \(+org_id', format(
      'SELECT id FROM bookings WHERE org_id=%L '
      'AND status IN (''confirmed'',''tentative'') '
      'AND checkout_date >= current_date - 7 AND checkin_date <= current_date + 60 '
      'ORDER BY checkin_date, id LIMIT 999', v_org)),

    -- turnovers/[id]/page.tsx's completed-turnover rating lookup. Scoped by
    -- turnover_id and NOT by org_id, so the policy is the ONLY thing keeping
    -- it tenant-safe — the exact shape flagged above as the one that bites.
    -- Probed for that reason: it is the read where an unhelpful plan would
    -- actually cost something.
    ('6_turnover_detail_rating', 'assignment_outcomes', 'pm', 'Index Cond: \(+turnover_id', format(
      'SELECT pm_rating FROM assignment_outcomes WHERE turnover_id=%L '
      'AND pm_rating IS NOT NULL LIMIT 1',
      (SELECT id FROM turnovers WHERE org_id = v_org ORDER BY id LIMIT 1))),

    -- The crew PWA's checklist-item pull (lib/dexie/sync/turnovers.ts), keyed
    -- on the denormalized turnover_id in chunks of 100 and drained by range.
    -- Run as CREW: this is the policy branch every PM plan above reports as
    -- `(never executed)`.
    ('7_crew_checklist_items_pull', 'checklist_instance_items', 'crew', 'Index Cond: \(+turnover_id', format(
      'SELECT id, instance_id, turnover_id, is_completed FROM checklist_instance_items '
      'WHERE turnover_id IN (%s) ORDER BY id LIMIT 1000',
      (SELECT string_agg(quote_literal(id::text), ',')
         FROM (SELECT t.id FROM turnovers t
                 WHERE t.org_id = v_org ORDER BY t.id LIMIT 100) c)));
END $$;

GRANT SELECT         ON plan_tgt, plan_portfolio, plan_props, plan_queries, plan_crew TO authenticated;
GRANT SELECT, INSERT ON plan_results TO authenticated;

-- ── Impersonate, exactly as PostgREST does ──────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT usr FROM plan_tgt), 'role', 'authenticated')::text,
  true);

DO $$
DECLARE
  q record; line text; buf text;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'PROBE ABORTED: impersonation failed, still running as %.', current_user;
  END IF;
  IF (SELECT auth.uid()) IS DISTINCT FROM (SELECT usr FROM plan_tgt) THEN
    RAISE EXCEPTION
      'PROBE ABORTED: auth.uid() is %, expected %. Policies match on auth.uid(), '
      'so every plan below would be the wrong user''s.',
      coalesce((SELECT auth.uid())::text, 'NULL'), (SELECT usr FROM plan_tgt);
  END IF;

  FOR q IN SELECT * FROM plan_queries ORDER BY name LOOP
    -- Swap the JWT subject per query rather than running two passes. The ROLE
    -- stays `authenticated`; only auth.uid() moves, which is all the policies
    -- read.
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', CASE q.run_as WHEN 'crew' THEN (SELECT usr FROM plan_crew)
                             ELSE (SELECT usr FROM plan_tgt) END,
        'role', 'authenticated')::text,
      true);

    buf := '';
    FOR line IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS) ' || q.sql LOOP
      buf := buf || line || E'\n';
    END LOOP;
    INSERT INTO plan_results(name, tbl, seeks_index, exec_ms, plan)
    VALUES (
      q.name,
      q.tbl,
      -- The assertion is POSITIVE — the probed table is reached by an index
      -- whose condition is org_id — rather than "no Seq Scan appears". A
      -- plan legitimately contains sequential scans of small tables inside
      -- the policy's own subplans (crew_members, turnover_assignments), and
      -- on the PM branch those are marked `(never executed)` because the OR
      -- short-circuits. Asserting their absence would fail on correct plans;
      -- asserting the seek is present says the thing actually meant.
      -- `Bitmap Heap Scan` counts as reaching the table by index: the crew
      -- read lands there (Bitmap Index Scan on
      -- idx_checklist_instance_items_turnover_id feeding a Bitmap Heap Scan),
      -- which is an index seek, not the table scan this probe exists to catch.
      buf ~ ('(Index (Only )?Scan using [a-z0-9_]+ on |Bitmap Heap Scan on )' || q.tbl)
        -- `\(+` and not `\(`: a single-column index condition prints as
        -- `Index Cond: (org_id = …)`, but a composite one — which is most of
        -- them here (idx_turnovers_org_status_checkout,
        -- idx_bookings_org_checkin) — prints as `Index Cond: ((org_id = …)
        -- AND (…))`. The one-paren form rejected both of those healthy plans
        -- and the probe reported a regression on its first real run. A check
        -- that cries wolf gets muted, which is the same defect as one that
        -- never fires.
        AND buf ~ q.expect_cond,
      nullif(substring(buf from 'Execution Time: ([0-9.]+) ms'), '')::numeric,
      buf
    );
  END LOOP;
END $$;

-- ── The canary ──────────────────────────────────────────────────────────────
-- Re-measure one query with index access disabled. The check above MUST call
-- this plan bad. If it does not, it cannot tell a good plan from a bad one and
-- every pass above is unmeasured.
SET LOCAL enable_indexscan     = off;
SET LOCAL enable_bitmapscan    = off;
SET LOCAL enable_indexonlyscan = off;

DO $$
DECLARE
  v_sql text := (SELECT sql FROM plan_queries WHERE name = '2_maintenance_board_schedules');
  line text; buf text := ''; v_ok boolean;
BEGIN
  FOR line IN EXECUTE 'EXPLAIN (ANALYZE) ' || v_sql LOOP buf := buf || line || E'\n'; END LOOP;

  v_ok := buf ~ '(Index (Only )?Scan using [a-z0-9_]+ on |Bitmap Heap Scan on )maintenance_schedules'
          AND buf ~ 'Index Cond: \(+org_id';

  IF v_ok THEN
    RAISE EXCEPTION
      'PROBE ABORTED: the canary PASSED. With index access disabled this plan '
      'cannot be seeking an index, so the shape check is not measuring what it '
      'claims and every result above is meaningless.';
  END IF;

  INSERT INTO plan_results(name, tbl, seeks_index, exec_ms, plan)
  VALUES ('0_CANARY_indexscan_disabled', 'maintenance_schedules', v_ok,
          nullif(substring(buf from 'Execution Time: ([0-9.]+) ms'), '')::numeric, buf);
END $$;

RESET ROLE;
SET LOCAL enable_indexscan     = on;
SET LOCAL enable_bitmapscan    = on;
SET LOCAL enable_indexonlyscan = on;

-- ── Assert ──────────────────────────────────────────────────────────────────
DO $$
DECLARE v_bad text[];
BEGIN
  -- `IS NOT TRUE` rather than `NOT seeks_index`: it catches NULL as well as
  -- false, so a query whose shape check could not be evaluated fails loudly
  -- instead of passing by absence.
  SELECT array_agg(name ORDER BY name) INTO v_bad
    FROM plan_results
   WHERE name <> '0_CANARY_indexscan_disabled' AND seeks_index IS NOT TRUE;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS PLAN REGRESSION: % did not seek its expected index at 872 properties '
      '(or its shape check could not be evaluated at all). '
      'Read the printed plan: an RLS-filtered sequential scan evaluates '
      'get_user_org_ids()/is_org_member() per candidate row, and that cost '
      'grows with the whole table rather than with one tenant.',
      array_to_string(v_bad, ', ');
  END IF;
END $$;

-- Both report SELECTs spell out ASC. It is cosmetic here — these order the
-- rows a human reads, not a paginated drain — but the probed queries above
-- state their direction explicitly too, and a file about sort correctness
-- should not leave its own ORDER BYs implicit.
SELECT name, tbl, seeks_index, exec_ms,
       (SELECT count(*) FROM plan_props)      AS seeded_properties,
       (SELECT count(*) FROM plan_portfolio)  AS seeded_orgs
  FROM plan_results ORDER BY name ASC;

SELECT name, plan FROM plan_results ORDER BY name ASC;

ROLLBACK;
