-- scripts/payload-volume-probe.sql
-- ============================================================================
-- PAYLOAD VOLUME probe at multi-tenant volume. Self-asserting. Rolls back.
--
-- WHAT THIS ANSWERS THAT rls-plan-probe.sql DOES NOT
--
-- That probe asked whether the database can FIND the rows cheaply, and the
-- answer at 872 properties was yes — every dashboard read seeks an org_id
-- index in single-digit milliseconds. It deliberately says nothing about how
-- many rows come back or how big they are, and those are a different failure:
-- a read can be index-perfect and still ship a payload that a phone cannot
-- deserialise on a turnover parking lot.
--
-- Two surfaces have that exposure and neither had ever been measured:
--
--   1. The PM boards (/turnovers, /ops). Both are Server Components that hand
--      their whole result set to a Client Component as props, so every row
--      crosses the RSC serialisation boundary and travels as flight data.
--      Nothing paginates, virtualises or windows on the client. The turnovers
--      board's window is 67 days wide and the ops snapshot's is 31.
--
--   2. The crew PWA's device cache. fetchAssignedTurnoverIds returns a crew
--      member's ENTIRE assignment scope with no date window, every one of
--      those turnovers is pulled into Dexie with its checklist instances and
--      items, and pruneLocalCache never removes a turnover — it derives its
--      live property set FROM the cached turnovers, so the turnovers
--      themselves are the root of the retention graph and only leave when the
--      server unassigns them. The cache is therefore bounded by a crew
--      member's LIFETIME assignment count, not by anything about today.
--
-- WHY BYTES AND ROWS, NOT MILLISECONDS
--
-- Same reasoning as the plan probe's, pointed the other way. Execution time on
-- a seeded fixture is not production's execution time. But a row count and a
-- serialised byte count ARE portable: a payload that is 40MB here is 40MB in
-- production for the same portfolio, on hardware this probe knows nothing
-- about. So this file measures size and asserts on size.
--
-- json_agg(...)::text is an APPROXIMATION of the React flight payload, not a
-- reproduction of it. Flight adds its own framing and dedupes repeated
-- strings, and the wire is compressed; the true transfer is smaller. What
-- carries over unchanged is the number this probe is actually for — the
-- volume the server must materialise, serialise and the client must parse and
-- hold, which no compression removes. Treat the figure as the right order of
-- magnitude and the right SHAPE of growth, not as a byte-exact wire size.
--
-- THE CEILINGS IT ASSERTS ON
--
-- Deliberately generous. These are not style thresholds and failing one is not
-- a nit — each marks the point where the surface stops working on the device
-- it is used from, so they are set where a reasonable engineer would agree the
-- thing is broken rather than where it is merely untidy:
--
--   BOARD_PAYLOAD_LIMIT   24MB per board. A Server Component's props are
--                         serialised into the HTML/flight stream and parsed on
--                         the main thread before anything renders. Past this a
--                         mid-range Android is multi-second blocked on parse
--                         alone, before React reconciles a single card.
--   CREW_CACHE_LIMIT     192MB per device. Browsers evict IndexedDB under
--                         storage pressure and a PWA that loses its cache
--                         offline loses the shift. Well under a typical quota
--                         so the assertion fires before the browser does.
--
-- A failure here is a CAPACITY finding, not a bug to patch with a bigger
-- constant — see the "Report and export caps" rule in CLAUDE.md. The fix for a
-- board is a window, a virtualised list or a server-side aggregate; the fix
-- for the crew cache is a retention horizon.
--
-- WHY IT ALSO PLANTS A CANARY
--
-- Same reason rls-plan-probe.sql and rls-isolation-probe.sql do. "Every
-- surface is under its ceiling" is the passing answer AND the answer from a
-- probe measuring an empty fixture, an org that was never seeded, or a query
-- that silently returned nothing. So the run re-measures one surface with a
-- deliberately absurd ceiling of zero bytes and REQUIRES that to fail. If the
-- canary passes, the probe cannot tell a large payload from a small one and
-- the run aborts rather than reporting healthy sizes.
--
-- SAFE ANYWHERE. Everything is inside one transaction that ends in ROLLBACK.
--
-- USAGE
--   bash scripts/run-payload-probe.sh
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/payload-volume-probe.sql
--
-- WHAT IT MEASURED (E2E project, 2026-09-29)
--
--   /turnovers    5,682 rows   2.32MB   (10% of ceiling)
--   /ops          2,005 rows   0.71MB   ( 3% of ceiling)
--   crew device 176,640 rows 103.84MB   (54% of ceiling), 276 round trips
--
-- The boards are not the problem and this probe exists partly to say so: the
-- concern that put it here was a guess, the guess was wrong by an order of
-- magnitude, and a measured 2.32MB closes it rather than leaving it open.
--
-- The crew device is the finding. 100MB of that 104MB is checklist_instance_items
-- alone, and it scales with a crew member's TENURE rather than with anything
-- about the account today — nothing on the device removes a turnover, so the
-- number below only goes up. At the seeded rate (1,250 assignments a year for a
-- full-time cleaner on a 334-property account) the fixture is ~2.6 years of
-- work, and the 192MB ceiling arrives somewhere around year five. The report's
-- projected_ceiling_years column below prints that estimate from whatever was
-- actually measured rather than from this paragraph.
--
-- ONE THING THE SEED UNDERSTATES. The fixture gives each property 8 turnovers
-- per 67 days — one per 8 days. A real short-term rental in season turns over
-- nearer every 3-4 days, so the BOARD figures could be ~2.4x what is printed,
-- which is ~5.5MB for /turnovers: still far inside the ceiling, and the
-- conclusion does not move. The crew figures are driven by the explicit
-- assignment history seeded below, not by this rate, so they are unaffected.
--
-- READING THE RESULT
--
-- One row per measured surface: rows, payload_mb, the ceiling it was checked
-- against, and round_trips where the surface is fetched in chunks (the crew
-- sync chunks .in() lists at IN_CHUNK_SIZE = 100 and drains each chunk at
-- max_rows = 1000, so its cost is round trips as much as bytes — on a phone
-- with a 300ms RTT, 40 sequential round trips is 12 seconds of nothing).
-- ============================================================================

BEGIN;

-- The 872-property / 14-org fixture, shared with rls-plan-probe.sql so the two
-- probes measure the same platform. \ir resolves relative to THIS file.
\ir probe-portfolio-seed.sql

-- ── A crew member's LIFETIME assignment history ─────────────────────────────
--
-- The shared fixture gives the probe crew member 800 assignments inside the
-- boards' own 67-day window, which is a fair picture of a live scope but not
-- of the thing being measured here. The crew cache has no date window at all,
-- so what fills it is TENURE: every turnover the crew member has ever been
-- assigned, still on the device.
--
-- So this seeds two more years behind the window. 5 turnovers a day, 5 days a
-- week, 50 weeks a year is 1,250 a year for one cleaner — the load a 334-
-- property account puts on a full-time crew member — so two years is 2,500.
-- That is the scope a device carries after the account's second anniversary,
-- and it keeps growing.
--
-- 57 checklist items each, not the fixture's 30: 56.6 is the live average
-- measured across production's checklist instances on 2026-09-29. The fixture
-- uses 30 because its purpose is plan shape, where the per-parent row count
-- only has to be plausible; here the number IS the measurement, so it is the
-- real one.
CREATE TEMP TABLE crew_history AS
  SELECT gen_random_uuid() AS turnover_id,
         gen_random_uuid() AS instance_id,
         pp.id             AS property_id,
         (SELECT org FROM plan_tgt) AS org_id,
         g                 AS n
    FROM (SELECT id, row_number() OVER (ORDER BY id) rn
            FROM plan_props WHERE org = (SELECT org FROM plan_tgt)) pp,
         generate_series(1, 8) g
   WHERE pp.rn <= 313;   -- 313 x 8 = 2,504, two years of one cleaner's work

INSERT INTO turnovers (id, org_id, property_id, checkout_datetime, checkin_datetime, status)
  SELECT turnover_id, org_id, property_id,
         -- spread back across 24 months, ending just before the board window
         now() - interval '8 days' - (n * interval '3 days')
               - ((row_number() OVER (ORDER BY turnover_id)) % 24) * interval '30 days',
         now() - interval '8 days' - (n * interval '3 days'),
         'completed'::turnover_status
    FROM crew_history;

INSERT INTO turnover_assignments (turnover_id, crew_member_id, org_id)
  SELECT turnover_id, (SELECT crew FROM plan_crew), org_id FROM crew_history;

INSERT INTO checklist_instances (id, org_id, turnover_id, template_snapshot)
  SELECT instance_id, org_id, turnover_id, '{}'::jsonb FROM crew_history;

INSERT INTO checklist_instance_items (instance_id, turnover_id, section_name, task, is_completed)
  SELECT ch.instance_id, ch.turnover_id,
         (ARRAY['Kitchen','Bathrooms','Bedrooms','Living','Exterior'])[1 + (s % 5)],
         'probe checklist task ' || s, true
    FROM crew_history ch, generate_series(1, 57) s;

ANALYZE turnovers, turnover_assignments, checklist_instances, checklist_instance_items;

-- ── The surfaces under measurement ──────────────────────────────────────────
--
-- Each `sql` is the read as the application writes it, including the
-- `.eq('org_id', …)` filter and the nested embed shape PostgREST returns, and
-- each is measured as the principal that actually issues it. Running under RLS
-- rather than as the owner is not ceremony: if a policy ever narrowed one of
-- these, the honest payload is the narrowed one, and a probe that measured
-- around RLS would keep reporting the old number.
--
-- round_trips is NULL where the surface is one request. Where it is not, the
-- value is computed from the sync layer's own constants — IN_CHUNK_SIZE = 100
-- for an .in() list (lib/dexie/sync/chunked.ts) and max_rows = 1000 per drained
-- page — because for the crew PWA the round-trip count is the cost that is
-- felt, not the bytes.
CREATE TEMP TABLE payload_queries(
  name        text PRIMARY KEY,
  surface     text NOT NULL,
  run_as      text NOT NULL CHECK (run_as IN ('pm','crew')),
  limit_bytes bigint NOT NULL CHECK (limit_bytes > 0),
  sql         text NOT NULL
);

CREATE TEMP TABLE payload_results(
  name        text PRIMARY KEY,
  surface     text,
  rows_out    bigint,
  bytes_out   bigint,
  limit_bytes bigint,
  round_trips int
);

-- plan_tgt/plan_crew come from the shared fixture, which does not grant them
-- (rls-plan-probe.sql issues its own GRANT after its include, for the temp
-- tables IT goes on to create). The measurement loop reads both to swap the
-- JWT subject per surface, so without these it fails at the first crew read
-- with a 42501 naming a pg_temp schema — a confusing way to say "the probe
-- forgot to grant its own scratch tables".
GRANT SELECT         ON plan_tgt, plan_crew, payload_queries, crew_history TO authenticated;
GRANT SELECT, INSERT ON payload_results TO authenticated;

DO $$
DECLARE
  v_org   uuid := (SELECT org  FROM plan_tgt);
  v_crew  uuid := (SELECT crew FROM plan_crew);
  -- Ceilings, in bytes. See the header for why each is where it is.
  BOARD_LIMIT bigint := 24 * 1024 * 1024;
  CREW_LIMIT  bigint := 192 * 1024 * 1024;
  -- The nested embed the two board reads share, spelled once.
  embed text := format(
    '(SELECT coalesce(json_agg(json_build_object('
    '  ''id'', ta.id, ''crew_member_id'', ta.crew_member_id,'
    '  ''crew_member'', json_build_object(''id'', cm.id, ''name'', cm.name,'
    '                                    ''phone'', cm.phone, ''email'', cm.email))), ''[]'')'
    '   FROM turnover_assignments ta'
    '   LEFT JOIN crew_members cm ON cm.id = ta.crew_member_id'
    '  WHERE ta.turnover_id = t.id) AS turnover_assignments');
BEGIN
  INSERT INTO payload_queries(name, surface, run_as, limit_bytes, sql) VALUES

  -- ── /turnovers — TurnoverBoard's six props ────────────────────────────────
  ('turnovers.1_turnovers', '/turnovers', 'pm', BOARD_LIMIT, format(
    'SELECT t.id, t.property_id, t.booking_id, t.prev_booking_id, t.checkout_datetime,'
    '       t.checkin_datetime, t.window_minutes, t.status, t.priority, t.notes,'
    '       t.completed_at, t.started_at, t.crew_duration_minutes, t.checklist_template_id,'
    '       t.is_same_day_turnover, t.is_archived, t.suggested_crew_ids,'
    '       t.suggestion_reasoning, t.suggestion_status, %s'
    '  FROM turnovers t'
    ' WHERE t.org_id = %L AND t.status <> ''cancelled'''
    '   AND t.checkout_datetime >= now() - interval ''7 days'''
    '   AND t.checkout_datetime <= now() + interval ''60 days''', embed, v_org)),

  ('turnovers.2_properties', '/turnovers', 'pm', BOARD_LIMIT, format(
    'SELECT id, name, city, state FROM properties'
    ' WHERE org_id = %L AND is_active', v_org)),

  ('turnovers.3_bookings', '/turnovers', 'pm', BOARD_LIMIT, format(
    'SELECT id, property_id, checkin_date, checkout_date, guest_name, status, source, stay_type'
    '  FROM bookings WHERE org_id = %L AND status IN (''confirmed'',''tentative'')'
    '   AND checkout_date >= (current_date - 7) AND checkin_date <= (current_date + 60)', v_org)),

  ('turnovers.4_crew_members', '/turnovers', 'pm', BOARD_LIMIT, format(
    'SELECT id, name, phone, email, specialty FROM crew_members'
    ' WHERE org_id = %L AND is_active', v_org)),

  ('turnovers.5_crew_availability', '/turnovers', 'pm', BOARD_LIMIT, format(
    'SELECT id, crew_member_id, available_date, is_available FROM crew_availability'
    ' WHERE org_id = %L AND available_date >= (current_date - 7)'
    '   AND available_date <= (current_date + 60)', v_org)),

  -- ── /ops — OpsSnapshot's props ────────────────────────────────────────────
  ('ops.1_turnovers', '/ops', 'pm', BOARD_LIMIT, format(
    'SELECT t.id, t.property_id, t.prev_booking_id, t.checkout_datetime, t.checkin_datetime,'
    '       t.window_minutes, t.status, t.priority, t.notes, t.completed_at, t.started_at,'
    '       t.checklist_template_id, %s'
    '  FROM turnovers t'
    ' WHERE t.org_id = %L AND t.status <> ''cancelled'''
    '   AND t.checkout_datetime >= date_trunc(''day'', now() - interval ''1 day'')'
    '   AND t.checkout_datetime <= date_trunc(''day'', now() + interval ''30 days'')',
    embed, v_org)),

  ('ops.2_properties', '/ops', 'pm', BOARD_LIMIT, format(
    'SELECT id, name, city, state, lat, lng FROM properties'
    ' WHERE org_id = %L AND is_active', v_org)),

  ('ops.3_month_bookings', '/ops', 'pm', BOARD_LIMIT, format(
    'SELECT id, property_id, checkin_date, checkout_date, status FROM bookings'
    ' WHERE org_id = %L AND status = ''confirmed'''
    '   AND checkout_date >= date_trunc(''month'', current_date)::date'
    '   AND checkin_date  <= (date_trunc(''month'', current_date) + interval ''1 month - 1 day'')::date',
    v_org)),

  -- ── The crew PWA device cache ─────────────────────────────────────────────
  -- Measured as the CREW principal, which is the half of these policies a PM
  -- session cannot reach: on a PM plan the crew branch reports
  -- `(never executed)` because the org_id test satisfies the OR first.
  ('crew.1_assignment_scope', 'crew device', 'crew', CREW_LIMIT, format(
    'SELECT turnover_id FROM turnover_assignments WHERE crew_member_id = %L', v_crew)),

  ('crew.2_turnovers', 'crew device', 'crew', CREW_LIMIT, format(
    'SELECT t.id, t.property_id, t.org_id, t.prev_booking_id, t.checkout_datetime,'
    '       t.checkin_datetime, t.window_minutes, t.status, t.priority, t.notes,'
    '       t.inventory_started_at, t.inventory_confirmed_complete_at,'
    '       t.inventory_confirmed_by_crew_id, t.completion_notes,'
    '       t.pending_checkout_datetime, t.pending_checkin_datetime,'
    '       t.dates_changed_at, t.dates_change_acknowledged_at, t.updated_at'
    '  FROM turnovers t'
    ' WHERE t.id IN (SELECT turnover_id FROM turnover_assignments WHERE crew_member_id = %L)',
    v_crew)),

  ('crew.3_checklist_instances', 'crew device', 'crew', CREW_LIMIT, format(
    'SELECT ci.* FROM checklist_instances ci'
    ' WHERE ci.turnover_id IN (SELECT turnover_id FROM turnover_assignments WHERE crew_member_id = %L)',
    v_crew)),

  ('crew.4_checklist_items', 'crew device', 'crew', CREW_LIMIT, format(
    'SELECT i.* FROM checklist_instance_items i'
    ' WHERE i.turnover_id IN (SELECT turnover_id FROM turnover_assignments WHERE crew_member_id = %L)',
    v_crew));
END $$;

-- ── Impersonate, exactly as PostgREST does ──────────────────────────────────
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  q         record;
  v_rows    bigint;
  v_bytes   bigint;
  v_assign  bigint;
  v_trips   int;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'PROBE ABORTED: impersonation failed, still running as %.', current_user;
  END IF;

  FOR q IN SELECT * FROM payload_queries ORDER BY name LOOP
    -- The ROLE stays `authenticated`; only auth.uid() moves, which is all the
    -- policies read. Swapped per surface rather than run in two passes.
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', CASE q.run_as WHEN 'crew' THEN (SELECT usr FROM plan_crew)
                             ELSE (SELECT usr FROM plan_tgt) END,
        'role', 'authenticated')::text,
      true);

    EXECUTE format(
      'SELECT count(*), octet_length(coalesce(json_agg(x)::text, ''[]''))'
      '  FROM (%s) x', q.sql)
      INTO v_rows, v_bytes;

    -- Round trips, from the sync layer's own constants. NULL for a board: a
    -- Server Component read is drained server-side inside one render, so its
    -- page count is not a cost the user waits on a network for.
    v_trips := NULL;
    IF q.surface = 'crew device' THEN
      SELECT count(*) INTO v_assign
        FROM turnover_assignments WHERE crew_member_id = (SELECT crew FROM plan_crew);
      v_trips := CASE q.name
        -- fetchAllPages: one drained read, max_rows = 1000 per page, plus the
        -- short page that ends the loop.
        WHEN 'crew.1_assignment_scope'  THEN (v_rows / 1000)::int + 1
        -- fetchInChunks: the id list is chunked at IN_CHUNK_SIZE and one row
        -- comes back per id, so the chunk count IS the round-trip count.
        WHEN 'crew.2_turnovers'         THEN ceil(v_assign / 100.0)::int
        WHEN 'crew.3_checklist_instances' THEN ceil(v_assign / 100.0)::int
        -- fetchInChunksPaginated: one-to-many, so every chunk is itself
        -- drained. This is the compounding one.
        WHEN 'crew.4_checklist_items'   THEN
          ceil(v_assign / 100.0)::int *
          ((CASE WHEN v_assign = 0 THEN 0
                 ELSE (v_rows * 100 / GREATEST(v_assign, 1)) END / 1000)::int + 1)
      END;
    END IF;

    INSERT INTO payload_results(name, surface, rows_out, bytes_out, limit_bytes, round_trips)
    VALUES (q.name, q.surface, v_rows, v_bytes, q.limit_bytes, v_trips);
  END LOOP;
END $$;

RESET ROLE;

-- ── Canary ──────────────────────────────────────────────────────────────────
-- A probe that measured nothing reports every surface comfortably under its
-- ceiling, which is indistinguishable from a healthy platform. So re-check the
-- largest measured surface against a ceiling of one byte and REQUIRE that to
-- fail. If it passes, the comparison is not working and no result below can be
-- trusted, so abort rather than report.
DO $$
DECLARE v_max bigint;
BEGIN
  SELECT max(bytes_out) INTO v_max FROM payload_results;

  IF v_max IS NULL THEN
    RAISE EXCEPTION
      'PROBE ABORTED: no surface was measured at all. The fixture did not seed, '
      'or every query returned no rows.';
  END IF;

  IF v_max <= 1 THEN
    RAISE EXCEPTION
      'PROBE ABORTED (CANARY): the largest measured surface is % bytes, which '
      'cannot be right for a 334-property org with two years of crew history. '
      'The probe is measuring an empty or wrong-org fixture, so "under the '
      'ceiling" below would mean nothing.', v_max;
  END IF;
END $$;

-- ── The assertion ───────────────────────────────────────────────────────────
DO $$
DECLARE v_bad text[];
BEGIN
  SELECT array_agg(
           format('%s: %.1fMB over a %.0fMB ceiling (%s rows)',
                  name, bytes_out / 1048576.0, limit_bytes / 1048576.0, rows_out)
           ORDER BY bytes_out DESC)
    INTO v_bad
    FROM payload_results
   WHERE bytes_out IS NULL OR bytes_out > limit_bytes;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION E'PAYLOAD CEILING EXCEEDED\n  %\n\n%',
      array_to_string(v_bad, E'\n  '),
      'This is a capacity finding, not a constant to raise. A board over its '
      'ceiling needs a narrower window, a virtualised list or a server-side '
      'aggregate; a crew cache over its ceiling needs a retention horizon on '
      'the assignment scope. See the header, and the "Report and export caps" '
      'rule in CLAUDE.md.';
  END IF;
END $$;

-- ONE report statement, detail rows plus a per-surface TOTAL, rather than two
-- SELECTs. A client that shows only the last result set (the Supabase MCP
-- execute_sql, among others) would otherwise drop whichever half came first,
-- and the totals are the number the finding gets written up from.
-- projected_ceiling_years answers the question a percentage cannot: the crew
-- cache has no retention horizon, so its size is a function of TENURE and the
-- useful number is when it arrives at the ceiling, not where it is today. The
-- divisor is the assignment rate the history seed models — 1,250 a year, a
-- full-time cleaner on a 334-property account — so the column reads "at this
-- rate, the device crosses the ceiling after N years of this person's
-- employment". NULL for the boards, whose size is set by a date window that
-- does not grow.
SELECT name,
       surface,
       rows_out,
       round(bytes_out / 1048576.0, 2)           AS payload_mb,
       round(100.0 * bytes_out / limit_bytes, 1) AS pct_of_ceiling,
       round(bytes_out::numeric / GREATEST(rows_out, 1), 0) AS bytes_per_row,
       round_trips,
       NULL::numeric                             AS projected_ceiling_years
  FROM payload_results
UNION ALL
SELECT 'TOTAL',
       r.surface,
       sum(r.rows_out),
       round(sum(r.bytes_out) / 1048576.0, 2),
       round(100.0 * sum(r.bytes_out) / max(r.limit_bytes), 1),
       NULL,
       sum(r.round_trips)::int,
       CASE WHEN r.surface = 'crew device' AND sum(r.bytes_out) > 0
            THEN round(
                   (max(r.limit_bytes)::numeric / sum(r.bytes_out))
                   * ((SELECT count(*) FROM crew_history) + 800) / 1250.0, 1)
       END
  FROM payload_results r GROUP BY r.surface
 ORDER BY surface ASC, name ASC;

ROLLBACK;
