DROP INDEX IF EXISTS work_orders_wo_number_unique;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_org_wo_number_unique
  ON work_orders(org_id, wo_number)
  WHERE wo_number IS NOT NULL;
