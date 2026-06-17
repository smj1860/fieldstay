-- Task 6: Fix work order "Operation failed" error
--
-- Root cause (confirmed via a rolled-back INSERT reproducing the exact
-- createWorkOrder() server action payload under RLS): wo_number is generated
-- per-org by next_wo_number()/wo_number_counters (format WO-<year>-<seq>,
-- counter keyed by org_id only), but work_orders_wo_number_unique enforced
-- uniqueness of wo_number *globally* across all orgs. Two different orgs
-- creating their Nth work order of the year generate the identical string
-- (e.g. both orgs' first 2026 WO become "WO-2026-0001"), so the second org's
-- insert raised 23505 against the first org's existing row. createWorkOrder()
-- (app/(dashboard)/maintenance/actions.ts) swallows that into the generic
-- "Operation failed. Please try again." with only a console.error of the
-- real Postgres error.

DROP INDEX IF EXISTS work_orders_wo_number_unique;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_org_wo_number_unique
  ON work_orders(org_id, wo_number)
  WHERE wo_number IS NOT NULL;
