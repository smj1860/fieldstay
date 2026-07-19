-- Auto-seeded room templates (Whole Home / Kitchen / Living Room / Bedroom /
-- Bathroom) + bedroom/bathroom mapping. See lib/checklists/seed-default-room-templates.ts
-- for the application-level seed logic this schema supports.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS bedroom_room_template_id  uuid REFERENCES room_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bathroom_room_template_id uuid REFERENCES room_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_room_templates_seeded_at timestamptz;

-- Required before the seed logic's upsert-on-conflict works. If this fails
-- to apply, an org somewhere already has two room_templates rows with the
-- same name — find and rename/merge the duplicate before retrying:
--   SELECT org_id, name, count(*) FROM room_templates
--   GROUP BY org_id, name HAVING count(*) > 1;
ALTER TABLE room_templates
  ADD CONSTRAINT room_templates_org_name_unique UNIQUE (org_id, name);

-- One-time data backfill: 20260718010000_seed_room_templates.sql seeded a
-- "Kitchen" room template for stephen@fieldstay.app's org before this
-- feature existed, without auto_include set. The new seed logic's
-- upsert-with-ignoreDuplicates will match that existing row by name and
-- silently skip it (by design — it must never overwrite a PM's own
-- customization), which would leave that one org's Kitchen permanently
-- excluded from every composed checklist. Narrowly correct just that row,
-- scoped to that specific org, mirroring the original migration's own
-- email-lookup pattern rather than a blanket UPDATE that could stomp a
-- real customer's deliberate customization elsewhere.
do $$
declare
  v_org_id uuid;
begin
  select om.org_id into v_org_id
  from public.organization_members om
  join auth.users u on u.id = om.user_id
  where u.email = 'stephen@fieldstay.app'
    and om.invite_accepted_at is not null
  limit 1;

  if v_org_id is not null then
    update public.room_templates
    set auto_include = true
    where org_id = v_org_id and name = 'Kitchen' and auto_include = false;
  end if;
end $$;
