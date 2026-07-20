-- pgTAP: cross-org RLS denial for owner_transactions (the owner P&L ledger).
-- Verifies an org_a admin cannot SELECT/UPDATE/DELETE an owner_transactions
-- row belonging to org_b, and that same-org access still works.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(4);

INSERT INTO auth.users (id) VALUES
  ('30000000-0000-0000-0000-000000000013');

INSERT INTO organizations (id, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000011', 'pgTAP Test Org A — owner_txns', 'pgtap-test-org-a-otx'),
  ('20000000-0000-0000-0000-000000000012', 'pgTAP Test Org B — owner_txns', 'pgtap-test-org-b-otx');

INSERT INTO organization_members (org_id, user_id, role, invite_accepted_at) VALUES
  ('10000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000013', 'admin', now());

INSERT INTO properties (id, org_id, name) VALUES
  ('40000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000011', 'Org A Property'),
  ('50000000-0000-0000-0000-000000000015', '20000000-0000-0000-0000-000000000012', 'Org B Property');

INSERT INTO owner_transactions (id, org_id, property_id, transaction_type, amount, description, transaction_date) VALUES
  ('60000000-0000-0000-0000-000000000016', '10000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000014', 'expense', 100.00, 'Org A txn', current_date),
  ('70000000-0000-0000-0000-000000000017', '20000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000015', 'expense', 200.00, 'Org B txn', current_date);

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"30000000-0000-0000-0000-000000000013","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM owner_transactions WHERE id = '70000000-0000-0000-0000-000000000017'),
  0,
  'cross-org SELECT: org_b transaction invisible to org_a admin'
);

WITH upd AS (
  UPDATE owner_transactions SET description = 'hacked' WHERE id = '70000000-0000-0000-0000-000000000017' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM upd), 0, 'cross-org UPDATE denied on org_b transaction');

WITH del AS (
  DELETE FROM owner_transactions WHERE id = '70000000-0000-0000-0000-000000000017' RETURNING 1
)
SELECT is((SELECT count(*)::int FROM del), 0, 'cross-org DELETE denied on org_b transaction');

SELECT is(
  (SELECT count(*)::int FROM owner_transactions WHERE id = '60000000-0000-0000-0000-000000000016'),
  1,
  'same-org SELECT: org_a transaction visible to org_a admin'
);

SELECT * FROM finish();
ROLLBACK;
