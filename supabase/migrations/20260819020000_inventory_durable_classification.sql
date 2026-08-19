-- 20260819020000_inventory_durable_classification.sql
-- ============================================================================
-- THE DURABLE/CONSUMABLE CLASSIFICATION, as decided by the operator.
--
-- 20260819010000 added is_consumable to inventory_catalog,
-- org_inventory_catalog and inventory_items with DEFAULT true and classified
-- nothing, deliberately: which items are durable is an operational judgment,
-- not a schema decision. This is that judgment, applied as data.
--
-- 72 durable, 85 consumable, 157 total — matching the platform catalog exactly
-- (verified in both directions: no name here is absent from the catalog, and
-- no catalog name is missing here).
--
-- Generated from the operator's reviewed spreadsheet rather than retyped, so
-- there is no transcription step between their decision and this file.
--
-- ── Two things worth knowing about the source data ─────────────────────────
--
-- 1. Four rows came back as "CONSUMABLES " (plural, trailing space) rather
--    than "CONSUMABLE": Mildew Remover, Rubber Gloves, Scrub Brushes and
--    First Aid Kit. Normalised — the intent is unambiguous and three of the
--    four are deliberate changes, so they were typed while editing.
--
-- 2. "Snow Shovels & Ice Melt" came back renamed to "Snow Shovels***" and
--    marked DURABLE. The classification is applied to the EXISTING catalog
--    name; the rename is NOT done here. It is a separate decision with data
--    consequences — the row bundles a tool with a consumable, so splitting
--    "Ice Melt" out as its own consumable item is probably what is actually
--    wanted, and renaming a catalog item also touches every org copy and
--    property row that was seeded from it.
--
-- ── Why the update matches on NAME ──────────────────────────────────────────
--
-- org_inventory_catalog.platform_catalog_item_id is nullable and ON DELETE SET
-- NULL (since 2026-07-21), and inventory_items.catalog_item_id is nullable
-- too. Neither link is something the seeded rows can be assumed to still have,
-- and both tables denormalise `name` from the catalog at seed time — so name
-- is the only join key that reaches every row that needs classifying.
--
-- Idempotent: re-running re-asserts the same values. It sets only the durables
-- (false); everything else keeps the column default of true, so a later
-- per-item correction toward "consumable" is not clobbered by a replay.
-- ============================================================================

CREATE TEMP TABLE _durables (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _durables (name) VALUES
  ('3 in 1 shower dispenser'), ('Baking Sheets & Pans'), ('Bath Mats'),
  ('Bath Towels'), ('Beach Chairs'), ('Beach Towels'), ('Blender'),
  ('Bottle Opener and Corkscrew'), ('Broom and Dustpan'),
  ('CO/CO2 Detectors'), ('Can Opener'), ('Chef Knife Block'),
  ('Coat Hangers'), ('Coffee Maker / Keurig'), ('Cooking Spoon'),
  ('Cookware Set'), ('Cutting Boards'), ('Dinnerware Set / Plates'),
  ('Dish Cloths and Towels'), ('Drinking Glasses'), ('Dryer Vent Brush'),
  ('Duvet Cover'), ('Duvet Insert / Comforter'), ('Extra Pillow Cases'),
  ('Extra Sheet Set'), ('Extra Throw Blanket'), ('Fire Extinguisher'),
  ('Fire Pit Tool Set'), ('Flashlight'), ('Flatware Set'),
  ('Garmet Steamer'), ('Grill Brush'), ('Guest Book'), ('HDMI Cable'),
  ('Hair Dryer'), ('Hand Towels'), ('Iron'), ('Ironing Board'),
  ('Lightning Cable'), ('Luggage Racks'), ('Makeup Towels'),
  ('Mattress Protector'), ('Measuring Cup Set'), ('Measuring Spoon Set'),
  ('Mesh Laundry Bags'), ('Microfiber Cloths'), ('Microwave'),
  ('Mixing Bowls'), ('Night Light'), ('Outdoor Drinkware'), ('Oven Mitts'),
  ('Patio String Light Bulbs'), ('Pillow Protectors'), ('Plunger Set'),
  ('Pool Towels'), ('Power Strip'), ('Screwdriver'),
  ('Snow Shovels & Ice Melt'), ('Spare Pillows'), ('Spatula'),
  ('Surge Protector Strip'), ('Swiffer Mop'), ('Toaster'),
  ('Toilet Brush & Caddy'), ('USB-A Charging Cable'),
  ('USB-C Charging Cable'), ('Universal TV Remote'), ('Washcloths'),
  ('Wine Glasses'), ('Wine Opener & Bottle Opener'), ('Wrench'),
  ('hand soap dispenser');

UPDATE inventory_catalog c
   SET is_consumable = false
  FROM _durables d
 WHERE c.name = d.name AND c.is_consumable IS DISTINCT FROM false;

UPDATE org_inventory_catalog o
   SET is_consumable = false
  FROM _durables d
 WHERE o.name = d.name AND o.is_consumable IS DISTINCT FROM false;

UPDATE inventory_items i
   SET is_consumable = false
  FROM _durables d
 WHERE i.name = d.name AND i.is_consumable IS DISTINCT FROM false;
