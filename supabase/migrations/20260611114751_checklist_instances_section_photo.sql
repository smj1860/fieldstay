ALTER TABLE public.checklist_instances
  ADD COLUMN IF NOT EXISTS section_photo_path text;

COMMENT ON COLUMN public.checklist_instances.section_photo_path IS
  'Storage path for the crew section completion photo. Set by handleSectionPhoto in the crew PWA.';
