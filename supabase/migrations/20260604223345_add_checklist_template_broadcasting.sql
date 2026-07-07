
ALTER TABLE public.checklist_template_sections
  ADD COLUMN IF NOT EXISTS requires_section_photo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.checklist_instance_items
  ADD COLUMN IF NOT EXISTS is_section_final_item BOOLEAN NOT NULL DEFAULT false;
