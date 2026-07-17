-- Modular room-based checklist templates (see FUTURE_ADDITIONS.md #2).
--
-- room_templates / room_template_items are a reusable, org-scoped library
-- of room modules ("Standard Bedroom," "Deluxe Bathroom") a PM builds once
-- and re-uses across properties, instead of hand-typing the same tasks
-- into every property's checklist independently.
--
-- checklist_template_sections gets a nullable pointer to the room module
-- it was populated from — NULL means "fully custom section," exactly what
-- every existing section already is, so this is purely additive.

CREATE TABLE IF NOT EXISTS public.room_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_templates_org_id ON public.room_templates (org_id);

CREATE TABLE IF NOT EXISTS public.room_template_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_template_id uuid NOT NULL REFERENCES public.room_templates(id) ON DELETE CASCADE,
  task             text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 500),
  requires_photo   boolean NOT NULL DEFAULT false,
  notes            text,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_template_items_room_id ON public.room_template_items (room_template_id);

ALTER TABLE public.checklist_template_sections
  ADD COLUMN IF NOT EXISTS room_template_id uuid REFERENCES public.room_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS room_synced_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_checklist_template_sections_room_id
  ON public.checklist_template_sections (room_template_id)
  WHERE room_template_id IS NOT NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Mirrors org_master_checklist_items's existing policy shape exactly.

ALTER TABLE public.room_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_template_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_templates      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_template_items TO authenticated;

CREATE POLICY "room_templates_manage"
  ON public.room_templates FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY "room_templates_select"
  ON public.room_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- room_template_items has no direct org_id — scope derives via the parent
-- room_templates row, same join pattern already used for
-- checklist_template_items/checklist_template_sections.

CREATE POLICY "room_template_items_manage"
  ON public.room_template_items FOR ALL
  USING (
    room_template_id IN (
      SELECT id FROM public.room_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
    )
  )
  WITH CHECK (
    room_template_id IN (
      SELECT id FROM public.room_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
    )
  );

CREATE POLICY "room_template_items_select"
  ON public.room_template_items FOR SELECT
  USING (
    room_template_id IN (
      SELECT id FROM public.room_templates WHERE org_id IN (SELECT get_user_org_ids())
    )
  );
