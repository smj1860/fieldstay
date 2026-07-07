CREATE TABLE crew_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name                text NOT NULL,
  email               text,
  phone               text,
  preferred_contact   contact_pref DEFAULT 'email',
  sms_carrier         text,
  specialty           text DEFAULT 'cleaning',
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_crew_members_org_id  ON crew_members(org_id);
CREATE INDEX idx_crew_members_user_id ON crew_members(user_id);
CREATE TRIGGER crew_members_updated_at BEFORE UPDATE ON crew_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION get_crew_member_id()
RETURNS uuid AS $$
  SELECT id FROM crew_members WHERE user_id = auth.uid() LIMIT 1
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  specialty       vendor_specialty DEFAULT 'general',
  portal_enabled  boolean NOT NULL DEFAULT false,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_vendors_org_id ON vendors(org_id);
CREATE TRIGGER vendors_updated_at BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id   uuid REFERENCES properties(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_checklist_templates_org_id      ON checklist_templates(org_id);
CREATE INDEX idx_checklist_templates_property_id ON checklist_templates(property_id);
CREATE TRIGGER checklist_templates_updated_at BEFORE UPDATE ON checklist_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_template_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_checklist_sections_template_id ON checklist_template_sections(template_id);

CREATE TABLE checklist_template_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id      uuid NOT NULL REFERENCES checklist_template_sections(id) ON DELETE CASCADE,
  template_id     uuid NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  task            text NOT NULL,
  requires_photo  boolean NOT NULL DEFAULT false,
  notes           text,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_checklist_items_section_id  ON checklist_template_items(section_id);
CREATE INDEX idx_checklist_items_template_id ON checklist_template_items(template_id);
