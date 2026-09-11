-- room_templates.name ("Kitchen", "Bedroom", "Living Room") becomes a
-- checklist_template_sections.name at apply time (lib/checklists/
-- apply-master-template.ts's insertComposedSections) — it IS the section
-- header the crew sees, so it needs the same Spanish sibling as
-- checklist_template_sections.name_es (20260910234151) to flow through.
-- Nullable, same fallback-to-English rule as every other _es column added
-- for the crew app's Spanish locale.

ALTER TABLE public.room_templates
  ADD COLUMN IF NOT EXISTS name_es text;

COMMENT ON COLUMN public.room_templates.name_es IS
  'PM-entered Spanish translation of name, copied into checklist_template_sections.name_es when this room template is applied to a property. Optional — falls back to name when null.';
