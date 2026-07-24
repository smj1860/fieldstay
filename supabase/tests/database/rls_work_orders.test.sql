-- pgTAP: cross-org RLS denial for work_orders.
-- Verifies an org_a admin cannot SELECT/UPDATE/DELETE a work order that
-- belongs to org_b, and that same-org access still works (so a broken
-- policy that blocks everyone can't pass this test by accident).
--
-- Run via: supabase test db
BEGIN;
SELECT plan(4);

-- Fixtures — inserted as the connecting (table-owner) role, which bypasses
-- RLS, exactly like an Inngest service-role write would.
INSERT INTO auth.users (id) VALUES
  ('30000000-0000-0000-0000-000000000003');

INSERT INTO organizations (id, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000001', 'pgTAP Test Org A — work_orders', 'pgtap-test-org-a-wo'),
  ('20000000-0000-0000-0000-000000000002', 'pgTAP Test Org B — work_orders', 'pgtap-test-org-b-wo');

-- CLAUDE.md: organization_members MUST have invite_accepted_at IS NOT NULL
-- to pass RLS — an org_a admin, never a member of org_b.
INSERT INTO organization_members (org_id, user_id, role, invite_accepted_at) VALUES
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'admin', now());

INSERT INTO properties (id, org_id, name) VALUES
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Org A Property'),
  ('50000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000002', 'Org B Property');

INSERT INTO work_orders (id, org_id, property_id, title) VALUES
  ('60000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 'Org A work order'),
  ('70000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000005', 'Org B work order');

-- Simulate the authenticated session PostgREST would establish for user_a —
-- see GoTrue's auth.uid(): nullif(current_setting('request.jwt.claims',
-- true)::json->>'sub', '')::uuid
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000003","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM work_orders WHERE id = '70000000-0000-0000-0000-000000000007'),
  0,
  'cross-org SELECT: org_b work order invisible to org_a admin'
);

WITH upd AS (
  UPDATE work_orders SET title = 'hacked' WHERE id = '70000000-0000-0000-0000-000000000007' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM upd), 0, 'cross-org UPDATE denied on org_b work order');

WITH del AS (
  DELETE FROM work_orders WHERE id = '70000000-0000-0000-0000-000000000007' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM del), 0, 'cross-org DELETE denied on org_b work order');

SELECT is(
  (SELECT count(*)::int FROM work_orders WHERE id = '60000000-0000-0000-0000-000000000006'),
  1,
  'same-org SELECT: org_a work order visible to org_a admin'
);

SELECT * FROM finish();
ROLLBACK;
