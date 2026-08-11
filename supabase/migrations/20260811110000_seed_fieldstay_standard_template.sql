-- Seed the FieldStay Standard Template — the platform template that legs 2 and
-- 3 will auto-apply at org signup and property creation.
--
-- 86 items curated by the owner from the 157-item master list. What it leaves
-- out is the point: all 6 Technology items, 14 of 15 Outdoor (only Bug Spray
-- survives — pool, hot tub, fire pit, beach and grill supplies are all
-- amenity-specific), and the cleaning chemicals, which are excluded on purpose
-- because many cleaners bring their own. A PM adds those to the individual
-- PROPERTY that needs them, never to this shared template — editing the
-- template would push pool salt onto every property in the org.
--
-- Source workbook fixes applied here, all owner-confirmed:
--   * five items appeared twice in the template tab (86 rows, 81 unique).
--     platform_inventory_template_items has UNIQUE (template_id,
--     catalog_item_id), so the duplicates could not all have inserted. Four
--     were identical; Fire Extinguisher appeared at par 2 AND par 1 — the
--     owner confirmed 1, which is also what the master tab says.
--   * the five new kitchen tools (Cooking Spoon, Cutting Boards, Mixing Bowls,
--     Oven Mitts, Spatula) were in the master tab but not the template tab;
--     the owner confirmed they belong in the standard.
--   * Creamer Cups existed only in the template tab. It is created by
--     20260811100000 as a rename of Coffee Creamer, so it resolves here.
--
-- Every one of the 86 was verified to resolve to a catalog row against the
-- POST-merge name set before this was written — catalog_item_id is NOT NULL
-- with an FK, so a miss would abort the whole insert.
--
-- The JOIN on c.name is what makes that safe, and it is also why this lands
-- DIFFERENTLY on the two projects: production seeds all 86, the E2E project
-- seeds 64, because its catalog holds 126 rows against production's 157. That
-- divergence predates all of this work (E2E was never seeded with the same
-- set) and is not introduced here. The JOIN drops the unmatched rows silently
-- rather than failing, which is the right behaviour for a seed — but it means
-- an E2E test must not assert a fixed item count for this template.
--
-- is_default = true is set inline rather than via
-- set_default_platform_inventory_template(): there are zero templates today,
-- so there is no existing default to clear and no scan-order hazard. The
-- partial unique index still guarantees exclusivity from here on.
--
-- Idempotent: the template insert is guarded by NOT EXISTS and the items by
-- ON CONFLICT DO NOTHING, so re-running changes nothing.

INSERT INTO public.platform_inventory_templates (name, description, is_default)
SELECT 'FieldStay Standard Template',
       'Items nearly every short-term rental needs. Amenity-specific supplies (pool, hot tub, fire pit, beach, grill) and cleaning chemicals are deliberately excluded — a PM adds those to the individual property that has them.',
       true
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_inventory_templates WHERE name = 'FieldStay Standard Template'
);

INSERT INTO public.platform_inventory_template_items
  (platform_inventory_template_id, catalog_item_id, par_level, par_mode, smart_group, base_qty, sort_order)
SELECT t.id, c.id, v.par, v.mode::par_mode, v.grp::par_smart_group, v.bq, v.sort_order
FROM (VALUES
  ('3 in 1 shower dispenser',3,'smart','bathroom_essential',1,0),
  ('Aluminum Foil',1,'static',NULL,1,1),
  ('Baking Sheets & Pans',2,'static',NULL,1,2),
  ('Bath Mats',5,'smart','bathroom_essential',2,3),
  ('Bath Towels',14,'smart','guest_consumable',2,4),
  ('Batteries 9V',4,'static',NULL,1,5),
  ('Batteries AA',8,'static',NULL,1,6),
  ('Batteries AAA',12,'static',NULL,1,7),
  ('Body Wash Bulk',2,'static',NULL,1,8),
  ('Bottled Water',1,'static',NULL,1,9),
  ('Broom and Dustpan',2,'static',NULL,1,10),
  ('Bug Spray',2,'static',NULL,1,11),
  ('Can Opener',1,'static',NULL,1,12),
  ('Chef Knife Block',1,'static',NULL,1,13),
  ('Coat Hangers',44,'smart','bedroom_essential',12,14),
  ('Coffee',1,'static',NULL,1,15),
  ('Coffee Filters',1,'static',NULL,1,16),
  ('Coffee K-Cup',27,'smart','guest_consumable',4,17),
  ('Coffee Maker / Keurig',1,'static',NULL,1,18),
  ('Command Strips',2,'static',NULL,1,19),
  ('Conditioner Bulk',2,'static',NULL,1,20),
  ('Cooking Spoon',2,'static',NULL,1,21),
  ('Cookware Set',1,'static',NULL,1,22),
  ('Creamer Cups',53,'smart','guest_consumable',8,23),
  ('Cutting Boards',2,'static',NULL,1,24),
  ('Dinnerware Set / Plates',14,'smart','guest_consumable',2,25),
  ('Dish Cloths and Towels',4,'static',NULL,1,26),
  ('Dish Soap',1,'static',NULL,1,27),
  ('Dishwasher Pods',1,'static',NULL,1,28),
  ('Disinfecting Wipes',1,'static',NULL,1,29),
  ('Disposable Razor',5,'smart','bathroom_essential',2,30),
  ('Drinking Glasses',14,'smart','guest_consumable',2,31),
  ('Dryer Sheets',1,'static',NULL,1,32),
  ('Duvet Cover',8,'smart','bedroom_essential',2,33),
  ('Duvet Insert / Comforter',4,'smart','bedroom_essential',1,34),
  ('Extra Pillow Cases',8,'smart','bedroom_essential',2,35),
  ('Extra Sheet Set',4,'smart','bedroom_essential',1,36),
  ('Extra Throw Blanket',3,'static',NULL,1,37),
  ('Facial Tissues',5,'smart','bathroom_essential',2,38),
  ('Fire Extinguisher',1,'static',NULL,1,39),
  ('First Aid Kit',1,'static',NULL,1,40),
  ('Flashlight',3,'static',NULL,1,41),
  ('Flatware Set',14,'smart','guest_consumable',2,42),
  ('Guest Book',1,'static',NULL,1,43),
  ('HVAC Air Filters',4,'static',NULL,1,44),
  ('Hair Dryer',3,'smart','bathroom_essential',1,45),
  ('Hand Soap Bulk',2,'static',NULL,1,46),
  ('Hand Towels',7,'smart','bathroom_essential',3,47),
  ('Iron',1,'static',NULL,1,48),
  ('Ironing Board',1,'static',NULL,1,49),
  ('Laundry Detergent/Pods',1,'static',NULL,1,50),
  ('Luggage Racks',4,'smart','bedroom_essential',1,51),
  ('Makeup Remover Wipes',3,'smart','bathroom_essential',1,52),
  ('Makeup Towels',7,'smart','bathroom_essential',3,53),
  ('Mattress Protector',4,'smart','bedroom_essential',1,54),
  ('Measuring Cup Set',1,'static',NULL,1,55),
  ('Measuring Spoon Set',1,'static',NULL,1,56),
  ('Mixing Bowls',2,'static',NULL,1,57),
  ('Napkins',2,'static',NULL,1,58),
  ('Outdoor Drinkware',14,'smart','guest_consumable',2,59),
  ('Oven Mitts',2,'static',NULL,1,60),
  ('Paper Towels',10,'static',NULL,1,61),
  ('Pepper',2,'static',NULL,1,62),
  ('Pillow Protectors',15,'smart','bedroom_essential',4,63),
  ('Plunger Set',3,'smart','bathroom_essential',1,64),
  ('Recessed/Other Light Bulbs',6,'static',NULL,1,65),
  ('Replacement Light Bulbs',12,'static',NULL,1,66),
  ('Salt',2,'static',NULL,1,67),
  ('Scrub Brushes',2,'static',NULL,1,68),
  ('Shampoo Bulk',2,'static',NULL,1,69),
  ('Spare Pillows',8,'smart','bedroom_essential',2,70),
  ('Spatula',2,'static',NULL,1,71),
  ('Sponges',6,'static',NULL,1,72),
  ('Stain Remover',2,'static',NULL,1,73),
  ('Sugar Packets',2,'static',NULL,1,74),
  ('Sweetener Packets',2,'static',NULL,1,75),
  ('Swiffer Mop',1,'static',NULL,1,76),
  ('Swiffer Refills',2,'static',NULL,1,77),
  ('Toilet Brush & Caddy',3,'smart','bathroom_essential',1,78),
  ('Toilet Paper',18,'static',NULL,1,79),
  ('Trash Bags - Kitchen',2,'static',NULL,1,80),
  ('Trash Bags - Small',2,'static',NULL,1,81),
  ('Washcloths',12,'smart','bathroom_essential',5,82),
  ('Washer Cleaning Tablets',2,'static',NULL,1,83),
  ('Wine Opener & Bottle Opener',2,'static',NULL,1,84),
  ('hand soap dispenser',3,'smart','bathroom_essential',1,85)
) AS v(name, par, mode, grp, bq, sort_order)
JOIN public.inventory_catalog c ON c.name = v.name
CROSS JOIN LATERAL (
  SELECT id FROM public.platform_inventory_templates WHERE name = 'FieldStay Standard Template'
) t
ON CONFLICT (platform_inventory_template_id, catalog_item_id) DO NOTHING;
