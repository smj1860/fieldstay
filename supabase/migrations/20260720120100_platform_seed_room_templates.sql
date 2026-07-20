-- Moves the previously hardcoded SEED_TEMPLATES array (in
-- lib/checklists/seed-default-room-templates.ts) into DB-backed tables, so a
-- platform admin can edit the default room-template content every new org
-- gets seeded with (Kitchen/Living Room/Whole Home/Bedroom/Bathroom) without
-- a code deploy. Global — not org-scoped; seedDefaultRoomTemplatesIfNeeded
-- reads this via the service-role client, same as it always has for the
-- literal array.
--
-- Seeded here with today's exact content, so behavior is unchanged for any
-- org that gets newly seeded the moment this migration ships.

CREATE TABLE IF NOT EXISTS public.platform_seed_room_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  auto_include boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_seed_room_template_items (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_seed_room_template_id uuid NOT NULL REFERENCES public.platform_seed_room_templates(id) ON DELETE CASCADE,
  task                            text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 500),
  requires_photo                  boolean NOT NULL DEFAULT false,
  notes                           text,
  sort_order                      int NOT NULL DEFAULT 0,
  created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_seed_room_template_items_template_id
  ON public.platform_seed_room_template_items (platform_seed_room_template_id);

ALTER TABLE public.platform_seed_room_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_seed_room_template_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_seed_room_templates      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_seed_room_template_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_seed_room_templates      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_seed_room_template_items TO service_role;

-- Not org-scoped, so there's no get_user_org_ids()-style read for regular
-- PMs to fall back to — this is internal platform config, read only by
-- seedDefaultRoomTemplatesIfNeeded (service role) and the platform admin UI.
CREATE POLICY "platform_seed_room_templates_manage"
  ON public.platform_seed_room_templates FOR ALL
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "platform_seed_room_template_items_manage"
  ON public.platform_seed_room_template_items FOR ALL
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

-- ── Seed: today's exact SEED_TEMPLATES content ─────────────────────────────

DO $$
DECLARE
  v_kitchen_id     uuid;
  v_livingroom_id  uuid;
  v_wholehome_id   uuid;
  v_bedroom_id     uuid;
  v_bathroom_id    uuid;
BEGIN
  -- Idempotent across re-runs: skip entirely if already seeded.
  IF EXISTS (SELECT 1 FROM public.platform_seed_room_templates) THEN
    RETURN;
  END IF;

  INSERT INTO public.platform_seed_room_templates (name, auto_include, sort_order)
  VALUES ('Kitchen', true, 0) RETURNING id INTO v_kitchen_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, sort_order) VALUES
    (v_kitchen_id, 'Wipe down all countertops and backsplash', 0),
    (v_kitchen_id, 'Clean stovetop and burners', 1),
    (v_kitchen_id, 'Wipe down oven interior and exterior', 2),
    (v_kitchen_id, 'Clean microwave inside and out', 3),
    (v_kitchen_id, 'Wipe exterior of refrigerator; clean inside and remove any old food', 4),
    (v_kitchen_id, 'Wash, dry, and put away any dishes; run dishwasher if needed', 5),
    (v_kitchen_id, 'Empty trash and replace liner', 6),
    (v_kitchen_id, 'Wipe cabinet fronts and handles', 7),
    (v_kitchen_id, 'Sweep and mop floor', 8),
    (v_kitchen_id, 'Restock dish soap, sponge, and paper towels', 9);

  INSERT INTO public.platform_seed_room_templates (name, auto_include, sort_order)
  VALUES ('Living Room', true, 1) RETURNING id INTO v_livingroom_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, sort_order) VALUES
    (v_livingroom_id, 'Dust all surfaces, shelves, and electronics', 0),
    (v_livingroom_id, 'Vacuum or sweep and mop floor', 1),
    (v_livingroom_id, 'Fluff and straighten couch cushions and throw pillows', 2),
    (v_livingroom_id, 'Fold and neatly arrange any throw blankets', 3),
    (v_livingroom_id, 'Wipe down coffee table and end tables', 4),
    (v_livingroom_id, 'Check under and between furniture cushions for anything a guest left behind', 5),
    (v_livingroom_id, 'Empty trash', 6),
    (v_livingroom_id, 'Straighten remotes and check/replace batteries if needed', 7);

  INSERT INTO public.platform_seed_room_templates (name, auto_include, sort_order)
  VALUES ('Whole Home', true, 2) RETURNING id INTO v_wholehome_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, sort_order) VALUES
    (v_wholehome_id, 'Check all windows are closed and locked', 0),
    (v_wholehome_id, 'Turn off all lights', 1),
    (v_wholehome_id, 'Set thermostat to the standard vacant temperature', 2),
    (v_wholehome_id, 'Empty all trash cans throughout the property, not just kitchen/bathrooms', 3),
    (v_wholehome_id, 'Confirm smoke and CO detectors are present and not beeping low-battery', 4),
    (v_wholehome_id, 'Walk every room and take photos for the condition record', 5),
    (v_wholehome_id, 'Lock all doors on exit', 6),
    (v_wholehome_id, 'Report any damage, missing items, or maintenance issues found', 7);

  INSERT INTO public.platform_seed_room_templates (name, auto_include, sort_order)
  VALUES ('Bedroom', false, 3) RETURNING id INTO v_bedroom_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, sort_order) VALUES
    (v_bedroom_id, 'Strip all bed linens and pillowcases', 0),
    (v_bedroom_id, 'Make bed with fresh linens', 1),
    (v_bedroom_id, 'Dust all furniture surfaces', 2),
    (v_bedroom_id, 'Vacuum floor and under bed', 3),
    (v_bedroom_id, 'Empty trash', 4),
    (v_bedroom_id, 'Check closet and dresser drawers for anything a guest left behind', 5),
    (v_bedroom_id, 'Restock extra blankets/pillows if the property provides them', 6);

  INSERT INTO public.platform_seed_room_templates (name, auto_include, sort_order)
  VALUES ('Bathroom', false, 4) RETURNING id INTO v_bathroom_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, sort_order) VALUES
    (v_bathroom_id, 'Scrub toilet bowl, seat, and base', 0),
    (v_bathroom_id, 'Clean sink, faucet, and countertop', 1),
    (v_bathroom_id, 'Wipe mirror', 2),
    (v_bathroom_id, 'Scrub shower/tub and glass doors', 3),
    (v_bathroom_id, 'Sweep and mop floor', 4),
    (v_bathroom_id, 'Empty trash and replace liner', 5),
    (v_bathroom_id, 'Restock toilet paper, hand soap, and shampoo/conditioner', 6),
    (v_bathroom_id, 'Replace bath mat if provided', 7);
END $$;
