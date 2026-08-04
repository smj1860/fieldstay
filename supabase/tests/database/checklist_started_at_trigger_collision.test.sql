-- pgTAP: regression test for the checklist_instances.started_at trigger
-- collision fixed by 20260730150000_fix_checklist_started_at_trigger_collision.sql.
--
-- Reproduces the exact production bug: a crew member (not a PM) completes
-- the first checklist_instance_item on their assigned turnover.
-- set_checklist_instance_started_at() (AFTER UPDATE on
-- checklist_instance_items) nested-UPDATEs checklist_instances.started_at,
-- which protect_checklist_instances_crew_columns() (BEFORE UPDATE on
-- checklist_instances) used to RAISE on for any non-PM caller — rolling
-- back the crew member's own is_completed write along with it. Confirms
-- the crew UPDATE now succeeds and started_at gets populated.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(2);

INSERT INTO auth.users (id) VALUES
  ('30000000-0000-0000-0000-000000000031');

INSERT INTO organizations (id, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000030', 'pgTAP Test Org — checklist trigger', 'pgtap-test-org-checklist');

INSERT INTO properties (id, org_id, name) VALUES
  ('40000000-0000-0000-0000-000000000032', '10000000-0000-0000-0000-000000000030', 'Checklist Trigger Test Property');

INSERT INTO turnovers (id, org_id, property_id, checkout_datetime, checkin_datetime) VALUES
  ('60000000-0000-0000-0000-000000000033', '10000000-0000-0000-0000-000000000030', '40000000-0000-0000-0000-000000000032', now(), now() + interval '1 day');

INSERT INTO crew_members (id, org_id, user_id, name) VALUES
  ('80000000-0000-0000-0000-000000000034', '10000000-0000-0000-0000-000000000030', '30000000-0000-0000-0000-000000000031', 'Test Crew Member');

INSERT INTO turnover_assignments (turnover_id, crew_member_id) VALUES
  ('60000000-0000-0000-0000-000000000033', '80000000-0000-0000-0000-000000000034');

INSERT INTO checklist_instances (id, turnover_id, org_id, template_snapshot, status) VALUES
  ('90000000-0000-0000-0000-000000000035', '60000000-0000-0000-0000-000000000033', '10000000-0000-0000-0000-000000000030', '{}'::jsonb, 'not_started');

INSERT INTO checklist_instance_items (id, instance_id, section_name, task) VALUES
  ('a0000000-0000-0000-0000-000000000036', '90000000-0000-0000-0000-000000000035', 'Kitchen', 'Wipe counters');

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000031","role":"authenticated"}';

-- The crew member's own completion write — this is the exact statement
-- that silently rolled back in production before the fix (raised inside
-- the nested started_at trigger, taking the outer is_completed write
-- down with it). Run as a plain statement rather than via pgTAP's
-- lives_ok(): lives_ok()'s dynamic EXECUTE reports "did not raise"
-- correctly but doesn't persist the write in this Supabase pgTAP setup,
-- which would make a false-negative-proof assertion — a plain statement
-- both surfaces an exception directly (aborting the whole test file, an
-- unambiguous failure) and its result is verified by the is()/isnt()
-- checks below reading the actual post-update row state. Verified this
-- reproduces the real bug: re-running this file against the pre-fix
-- version of protect_checklist_instances_crew_columns() raises exactly
-- the production error ("crew members may only update completed_at and
-- completed_by_crew_id on checklist_instances").
UPDATE checklist_instance_items
SET is_completed = true, completed_at = now(), completed_by_crew_id = '80000000-0000-0000-0000-000000000034'
WHERE id = 'a0000000-0000-0000-0000-000000000036';

SELECT is(
  (SELECT is_completed FROM checklist_instance_items WHERE id = 'a0000000-0000-0000-0000-000000000036'),
  true,
  'the crew completion UPDATE succeeded without raising and landed'
);

SELECT isnt(
  (SELECT started_at FROM checklist_instances WHERE id = '90000000-0000-0000-0000-000000000035'),
  NULL,
  'checklist_instances.started_at was set by the nested trigger'
);

SELECT * FROM finish();
ROLLBACK;
