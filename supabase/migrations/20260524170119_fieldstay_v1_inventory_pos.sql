
-- INVENTORY CATALOG
CREATE TABLE inventory_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  category      inventory_category NOT NULL DEFAULT 'other',
  default_unit  text NOT NULL DEFAULT 'units',
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

-- INVENTORY ITEMS
CREATE TABLE inventory_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_item_id         uuid REFERENCES inventory_catalog(id) ON DELETE SET NULL,
  name                    text NOT NULL,
  category                inventory_category NOT NULL DEFAULT 'other',
  unit                    text NOT NULL DEFAULT 'units',
  par_level               integer NOT NULL DEFAULT 0,
  current_quantity        integer NOT NULL DEFAULT 0,
  low_stock_threshold_pct integer NOT NULL DEFAULT 30,
  is_active               boolean NOT NULL DEFAULT true,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_items_property_id ON inventory_items(property_id);
CREATE INDEX idx_inventory_items_org_id      ON inventory_items(org_id);

CREATE TRIGGER inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- INVENTORY COUNTS
CREATE TABLE inventory_counts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submitted_by_crew_id  uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  submitted_at          timestamptz NOT NULL DEFAULT NOW(),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_counts_property_id ON inventory_counts(property_id);

CREATE TABLE inventory_count_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id          uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_counted  integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_count_items_count_id ON inventory_count_items(count_id);

-- PURCHASE ORDERS
CREATE TABLE purchase_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status                po_status NOT NULL DEFAULT 'draft',
  generated_at          timestamptz NOT NULL DEFAULT NOW(),
  sent_at               timestamptz,
  acknowledged_at       timestamptz,
  notes                 text,
  total_estimated_cost  numeric(10,2),
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_orders_property_id ON purchase_orders(property_id);
CREATE INDEX idx_purchase_orders_org_id      ON purchase_orders(org_id);
CREATE INDEX idx_purchase_orders_status      ON purchase_orders(status);

CREATE TRIGGER purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id   uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id   uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name           text NOT NULL,
  current_quantity    integer NOT NULL,
  par_level           integer NOT NULL,
  quantity_to_buy     integer NOT NULL,
  estimated_unit_cost numeric(8,2),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_po_items_purchase_order_id ON purchase_order_items(purchase_order_id);
