
-- TURNOVERS
CREATE TABLE turnovers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id            uuid REFERENCES bookings(id) ON DELETE SET NULL,
  prev_booking_id       uuid REFERENCES bookings(id) ON DELETE SET NULL,
  checkout_datetime     timestamptz NOT NULL,
  checkin_datetime      timestamptz NOT NULL,
  window_minutes        integer,
  status                turnover_status NOT NULL DEFAULT 'pending_assignment',
  priority              priority_level NOT NULL DEFAULT 'medium',
  checklist_template_id uuid REFERENCES checklist_templates(id) ON DELETE SET NULL,
  notes                 text,
  completion_notes      text,
  completed_at          timestamptz,
  auto_generated        boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turnovers_property_id    ON turnovers(property_id);
CREATE INDEX idx_turnovers_org_id         ON turnovers(org_id);
CREATE INDEX idx_turnovers_status         ON turnovers(status);
CREATE INDEX idx_turnovers_checkout       ON turnovers(checkout_datetime);

CREATE TRIGGER turnovers_updated_at
  BEFORE UPDATE ON turnovers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- TURNOVER ASSIGNMENTS
CREATE TABLE turnover_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turnover_id       uuid NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  crew_member_id    uuid NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  assigned_at       timestamptz NOT NULL DEFAULT NOW(),
  notified_at       timestamptz,
  notification_type contact_pref,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_turnover_assignments_turnover_id  ON turnover_assignments(turnover_id);
CREATE INDEX idx_turnover_assignments_crew_id      ON turnover_assignments(crew_member_id);

-- CHECKLIST INSTANCES
CREATE TABLE checklist_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turnover_id       uuid NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id       uuid REFERENCES checklist_templates(id) ON DELETE SET NULL,
  template_snapshot jsonb NOT NULL,
  status            checklist_status NOT NULL DEFAULT 'not_started',
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_instances_turnover_id ON checklist_instances(turnover_id);
CREATE INDEX idx_checklist_instances_org_id      ON checklist_instances(org_id);

CREATE TRIGGER checklist_instances_updated_at
  BEFORE UPDATE ON checklist_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_instance_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id           uuid NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  section_name          text NOT NULL,
  task                  text NOT NULL,
  requires_photo        boolean NOT NULL DEFAULT false,
  notes                 text,
  sort_order            integer NOT NULL DEFAULT 0,
  is_completed          boolean NOT NULL DEFAULT false,
  completed_at          timestamptz,
  completed_by_crew_id  uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  photo_storage_path    text,
  crew_notes            text,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_instance_items_instance_id ON checklist_instance_items(instance_id);

CREATE TRIGGER checklist_instance_items_updated_at
  BEFORE UPDATE ON checklist_instance_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
