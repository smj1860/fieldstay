-- scripts/probe-portfolio-seed.sql
-- ============================================================================
-- THE SHARED FIXTURE. Included with \ir by every probe that needs multi-tenant
-- volume; it is not runnable on its own and opens no transaction of its own —
-- the including file owns the BEGIN and the ROLLBACK.
--
--   1 org x 334 properties   (the large account)
--   3 orgs x  90             (70-110 band)
--   4 orgs x  40             (30-50 band)
--   6 orgs x  18             (12-25 band)
--   = 872 properties across 14 orgs
--
-- Ratios per property are the live figures recorded in CLAUDE.md: 18 active
-- maintenance schedules, 9 assets. Seeding the OTHER thirteen tenants is the
-- point rather than padding: RLS scan cost and table size track the WHOLE
-- table, not one tenant's share of it, so measuring the large account alone
-- would understate every plan and every scan.
--
-- Extracted from rls-plan-probe.sql when board-payload-probe.sql needed the
-- same portfolio. Two copies of a fixture is two definitions of "the platform
-- we are testing against", and they drift — the numbers in one probe's output
-- stop being comparable with the other's, silently.
-- ============================================================================

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
