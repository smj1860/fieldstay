
-- WORK ORDERS
CREATE TABLE work_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                 uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id                   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  assigned_crew_id            uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  title                       text NOT NULL,
  description                 text,
  priority                    priority_level NOT NULL DEFAULT 'medium',
  status                      wo_status NOT NULL DEFAULT 'pending',
  source                      wo_source NOT NULL DEFAULT 'manual',
  source_schedule_id          uuid,
  scheduled_date              date,
  completed_date              date,
  estimated_cost              numeric(10,2),
  actual_cost                 numeric(10,2),
  portal_enabled              boolean NOT NULL DEFAULT false,
  completion_token            uuid UNIQUE DEFAULT gen_random_uuid(),
  completion_token_expires_at timestamptz,
  completion_notes            text,
  invoice_reference           text,
  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_orders_property_id       ON work_orders(property_id);
CREATE INDEX idx_work_orders_org_id            ON work_orders(org_id);
CREATE INDEX idx_work_orders_status            ON work_orders(status);
CREATE INDEX idx_work_orders_completion_token  ON work_orders(completion_token);
CREATE INDEX idx_work_orders_scheduled_date    ON work_orders(scheduled_date);

CREATE TRIGGER work_orders_updated_at
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_order_updates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id             uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  updated_by_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_via_vendor_portal boolean NOT NULL DEFAULT false,
  status_from               wo_status,
  status_to                 wo_status,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wo_updates_work_order_id ON work_order_updates(work_order_id);

CREATE TABLE work_order_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id   uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,
  uploaded_by     text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wo_photos_work_order_id ON work_order_photos(work_order_id);

-- MAINTENANCE SCHEDULES
CREATE TABLE maintenance_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_vendor_id  uuid REFERENCES vendors(id) ON DELETE SET NULL,
  name                text NOT NULL,
  description         text,
  schedule_type       schedule_type NOT NULL DEFAULT 'routine',
  frequency           schedule_frequency,
  month_due           integer CHECK (month_due BETWEEN 1 AND 12),
  day_of_month_due    integer CHECK (day_of_month_due BETWEEN 1 AND 31),
  estimated_cost      numeric(10,2),
  instructions        text,
  auto_create_wo      boolean NOT NULL DEFAULT false,
  last_completed_date date,
  next_due_date       date,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_maintenance_schedules_property_id ON maintenance_schedules(property_id);
CREATE INDEX idx_maintenance_schedules_next_due    ON maintenance_schedules(next_due_date);
CREATE INDEX idx_maintenance_schedules_org_id      ON maintenance_schedules(org_id);

CREATE TRIGGER maintenance_schedules_updated_at
  BEFORE UPDATE ON maintenance_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
