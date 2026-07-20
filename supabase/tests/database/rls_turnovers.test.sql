-- pgTAP: cross-org RLS denial for turnovers.
-- Verifies an org_a admin cannot SELECT/UPDATE/DELETE a turnover belonging
-- to org_b, and that same-org access still works. Note: the turnovers
-- status column is `status`, not `turnover_status` as CLAUDE.md's schema
-- section names it — this test uses the real live column name.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(4);

INSERT INTO auth.users (id) VALUES
  ('30000000-0000-0000-0000-000000000023');

INSERT INTO organizations (id, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000021', 'pgTAP Test Org A — turnovers', 'pgtap-test-org-a-to'),
  ('20000000-0000-0000-0000-000000000022', 'pgTAP Test Org B — turnovers', 'pgtap-test-org-b-to');

INSERT INTO organization_members (org_id, user_id, role, invite_accepted_at) VALUES
  ('10000000-0000-0000-0000-000000000021', '30000000-0000-0000-0000-000000000023', 'admin', now());

INSERT INTO properties (id, org_id, name) VALUES
  ('40000000-0000-0000-0000-000000000024', '10000000-0000-0000-0000-000000000021', 'Org A Property'),
  ('50000000-0000-0000-0000-000000000025', '20000000-0000-0000-0000-000000000022', 'Org B Property');

INSERT INTO turnovers (id, org_id, property_id, checkout_datetime, checkin_datetime) VALUES
  ('60000000-0000-0000-0000-000000000026', '10000000-0000-0000-0000-000000000021', '40000000-0000-0000-0000-000000000024', now(), now() + interval '1 day'),
  ('70000000-0000-0000-0000-000000000027', '20000000-0000-0000-0000-000000000022', '50000000-0000-0000-0000-000000000025', now(), now() + interval '1 day');

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000023","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM turnovers WHERE id = '70000000-0000-0000-0000-000000000027'),
  0,
  'cross-org SELECT: org_b turnover invisible to org_a admin'
);

WITH upd AS (
  UPDATE turnovers SET status = 'flagged' WHERE id = '70000000-0000-0000-0000-000000000027' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM upd), 0, 'cross-org UPDATE denied on org_b turnover');

WITH del AS (
  DELETE FROM turnovers WHERE id = '70000000-0000-0000-0000-000000000027' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM del), 0, 'cross-org DELETE denied on org_b turnover');

SELECT is(
  (SELECT count(*)::int FROM turnovers WHERE id = '60000000-0000-0000-0000-000000000026'),
  1,
  'same-org SELECT: org_a turnover visible to org_a admin'
);

SELECT * FROM finish();
ROLLBACK;
