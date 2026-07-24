-- pgTAP: cross-org RLS denial for vendor_compliance_documents (the
-- compliance vault — COIs, licenses, bonding).
-- Verifies an org_a admin cannot SELECT/UPDATE/DELETE a compliance document
-- belonging to org_b, and that same-org access still works.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(4);

INSERT INTO auth.users (id) VALUES
  ('30000000-0000-0000-0000-000000000033');

INSERT INTO organizations (id, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000031', 'pgTAP Test Org A — vcd', 'pgtap-test-org-a-vcd'),
  ('20000000-0000-0000-0000-000000000032', 'pgTAP Test Org B — vcd', 'pgtap-test-org-b-vcd');

INSERT INTO organization_members (org_id, user_id, role, invite_accepted_at) VALUES
  ('10000000-0000-0000-0000-000000000031', '30000000-0000-0000-0000-000000000033', 'admin', now());

INSERT INTO vendors (id, org_id, name) VALUES
  ('40000000-0000-0000-0000-000000000034', '10000000-0000-0000-0000-000000000031', 'Org A Vendor'),
  ('50000000-0000-0000-0000-000000000035', '20000000-0000-0000-0000-000000000032', 'Org B Vendor');

INSERT INTO vendor_compliance_documents (id, org_id, vendor_id, document_type, document_name) VALUES
  ('60000000-0000-0000-0000-000000000036', '10000000-0000-0000-0000-000000000031', '40000000-0000-0000-0000-000000000034', 'coi', 'Org A COI'),
  ('70000000-0000-0000-0000-000000000037', '20000000-0000-0000-0000-000000000032', '50000000-0000-0000-0000-000000000035', 'coi', 'Org B COI');

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000033","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM vendor_compliance_documents WHERE id = '70000000-0000-0000-0000-000000000037'),
  0,
  'cross-org SELECT: org_b compliance document invisible to org_a admin'
);

WITH upd AS (
  UPDATE vendor_compliance_documents SET document_name = 'hacked' WHERE id = '70000000-0000-0000-0000-000000000037' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM upd), 0, 'cross-org UPDATE denied on org_b compliance document');

WITH del AS (
  DELETE FROM vendor_compliance_documents WHERE id = '70000000-0000-0000-0000-000000000037' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM del), 0, 'cross-org DELETE denied on org_b compliance document');

SELECT is(
  (SELECT count(*)::int FROM vendor_compliance_documents WHERE id = '60000000-0000-0000-0000-000000000036'),
  1,
  'same-org SELECT: org_a compliance document visible to org_a admin'
);

SELECT * FROM finish();
ROLLBACK;
