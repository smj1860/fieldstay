
-- WO number counter table
CREATE TABLE IF NOT EXISTS wo_number_counters (
  org_id       uuid     PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number  integer  NOT NULL DEFAULT 0,
  current_year smallint NOT NULL DEFAULT EXTRACT(YEAR FROM NOW())::smallint
);

ALTER TABLE wo_number_counters ENABLE ROW LEVEL SECURITY;

-- WO number generator function
CREATE OR REPLACE FUNCTION next_wo_number(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_year   smallint := EXTRACT(YEAR FROM NOW())::smallint;
  v_number integer;
BEGIN
  INSERT INTO wo_number_counters (org_id, last_number, current_year)
  VALUES (p_org_id, 1, v_year)
  ON CONFLICT (org_id) DO UPDATE
    SET last_number  = CASE
                         WHEN wo_number_counters.current_year = v_year
                         THEN wo_number_counters.last_number + 1
                         ELSE 1
                       END,
        current_year = v_year
  RETURNING last_number INTO v_number;
  RETURN 'WO-' || v_year || '-' || LPAD(v_number::text, 4, '0');
END;
$$;

-- New enum types
DO $$ BEGIN
  CREATE TYPE wo_category AS ENUM (
    'hvac','plumbing','electrical','appliance','cleaning',
    'landscaping','roofing','flooring','windows_doors',
    'pest_control','pool','structural','general','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE line_item_type AS ENUM (
    'labor','material','equipment','subcontractor','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add access_instructions to properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS access_instructions text;

-- Add new columns to work_orders
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS wo_number               text UNIQUE,
  ADD COLUMN IF NOT EXISTS category                wo_category,
  ADD COLUMN IF NOT EXISTS nte_amount              numeric(10,2),
  ADD COLUMN IF NOT EXISTS access_notes            text,
  ADD COLUMN IF NOT EXISTS vendor_acknowledged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_acknowledged_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_verified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS completion_verified_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Auto-assign WO number trigger
CREATE OR REPLACE FUNCTION assign_wo_number()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS work_orders_assign_number ON work_orders;
CREATE TRIGGER work_orders_assign_number
  BEFORE INSERT ON work_orders
  FOR EACH ROW EXECUTE FUNCTION assign_wo_number();

-- Line items table
CREATE TABLE IF NOT EXISTS work_order_line_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  line_type     line_item_type NOT NULL DEFAULT 'material',
  description   text NOT NULL,
  quantity      numeric(8,2)  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit          text,
  unit_cost     numeric(10,2) NOT NULL CHECK (unit_cost >= 0),
  line_total    numeric(10,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_line_items_work_order_id ON work_order_line_items(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_line_items_org_id        ON work_order_line_items(org_id);

ALTER TABLE work_order_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members view org line items"
  ON work_order_line_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Managers and above insert line items"
  ON work_order_line_items FOR INSERT
  WITH CHECK (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

CREATE POLICY "Managers and above delete line items"
  ON work_order_line_items FOR DELETE
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_order_line_items TO anon, authenticated;

-- Sync actual_cost from line items
CREATE OR REPLACE FUNCTION sync_wo_actual_cost()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_wo_id      uuid;
  v_item_count integer;
  v_total      numeric(10,2);
BEGIN
  v_wo_id := COALESCE(NEW.work_order_id, OLD.work_order_id);
  SELECT COUNT(*), COALESCE(SUM(line_total), 0)
  INTO v_item_count, v_total
  FROM work_order_line_items
  WHERE work_order_id = v_wo_id;
  IF v_item_count > 0 THEN
    UPDATE work_orders SET actual_cost = v_total WHERE id = v_wo_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sync_wo_cost_on_line_items ON work_order_line_items;
CREATE TRIGGER sync_wo_cost_on_line_items
  AFTER INSERT OR UPDATE OR DELETE ON work_order_line_items
  FOR EACH ROW EXECUTE FUNCTION sync_wo_actual_cost();

-- Backfill WO numbers on existing records
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, org_id, created_at FROM work_orders
    WHERE wo_number IS NULL ORDER BY org_id, created_at
  LOOP
    UPDATE work_orders SET wo_number = next_wo_number(r.org_id) WHERE id = r.id;
  END LOOP;
END;
$$;
