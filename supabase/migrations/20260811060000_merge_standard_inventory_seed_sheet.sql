-- Merge the standard-inventory seed sheet into the platform catalog: 133 -> 152.
--
-- Master list = the owner's seed sheet UNION the FieldStay items kept after the
-- 14 retired by 20260811040000. Three parts:
--   1. 114 matched rows REVISED IN PLACE. Updated, never delete+reinsert, so
--      inventory_catalog.id survives -- 842 property inventory_items, 228 org
--      template items and 115 org catalog copies point at these ids, and three
--      of those four FKs are ON DELETE SET NULL, i.e. they would have been
--      silently unlinked rather than erroring.
--   2. 19 new items INSERTed (guarded by NOT EXISTS, so re-running is a no-op).
--   3. 19 kept rows given a flat default_par_level, each derived from the
--      closest analogue in the sheet rather than invented -- cleaning chemicals
--      to 1 like All-Purpose/Bathroom/Glass Cleaner, Plastic Wrap to 1 roll like
--      its sibling Aluminum Foil, per-stay Welcome Cards to 4 like the Coffee
--      Welcome Pack, and so on.
--
-- PAR CONFIG. The sheet's Per Bedroom / Per Bathroom / Per Guest columns map
-- exactly onto the three smart groups already in lib/inventory/par-engine.ts:
-- 34 smart rows (14 bathroom_essential, 10 guest_consumable, 10 bedroom_
-- essential) and 118 static. base_qty carries the per-unit multiplier.
--
-- default_par_level on a smart row is a NOT NULL pre-recompute fallback that
-- the resolver overwrites on first run. Rather than derive one from the live
-- portfolio -- median max_guests reads 2.0 against a 4.81 average, so a chunk
-- of rows carry placeholder values -- it is computed against a documented
-- 3bd/2ba/6-guest reference using each group's own buffer, which sits above the
-- portfolio average and so errs high per the owner's standing rule.
--
-- Disposable Razor carried BOTH a flat par of 4 and 2/bathroom. The
-- inventory_catalog_smart_group_matches_mode CHECK rejects that outright, so
-- the multiplier wins and the flat 4 is dropped (a 4-bath house gets 8).
--
-- Verified before applying: no post-merge name collisions, and no
-- order-dependent rename hazard (no new name equals another pair's old name).
-- inventory_catalog has NO unique index on name, so neither would have raised
-- an error -- they would have produced duplicate or mis-targeted rows.
--
-- STILL OPEN, deliberately left as-is rather than guessed:
--   Lotion (flat 2 as a bulk refill, vs 1/bathroom if it is a placement)
--   Tea Bags and Coffee Creamer (flat, vs per-guest like Coffee K-Cup)
--   Surge Protector Strip duplicates Power Strip; Bottle Opener and Corkscrew
--     overlaps the new Wine Opener & Bottle Opener. Both retained pending a
--     decision on which name survives.

-- Three set-based statements rather than 152 singles: each part applies
-- atomically, and a partial catalog is not a state worth being able to reach.

UPDATE public.inventory_catalog c SET
  name=v.new_name, category=v.category::inventory_category, default_unit=v.unit,
  default_par_level=v.par, par_mode=v.mode::par_mode,
  smart_group=v.grp::par_smart_group, base_qty=v.bq
FROM (VALUES
  ('All-Purpose Cleaner','All-Purpose Cleaner','cleaning','bottles',1,'static',NULL,1),
  ('Aluminum Foil','Aluminum Foil','kitchen','rolls',1,'static',NULL,1),
  ('Baking Sheets & Casserole Dishes','Baking Sheets & Pans','kitchen','each',2,'static',NULL,1),
  ('Bath Mats','Bath Mats','bath','each',5,'smart','bathroom_essential',2),
  ('Bath Towels','Bath Towels','bath','each',14,'smart','guest_consumable',2),
  ('Bathroom Cleaner','Bathroom Cleaner','cleaning','bottles',1,'static',NULL,1),
  ('Batteries 9V','Batteries 9V','maintenance_safety','each',4,'static',NULL,1),
  ('Batteries AA','Batteries AA','maintenance_safety','each',8,'static',NULL,1),
  ('Batteries AAA','Batteries AAA','maintenance_safety','each',12,'static',NULL,1),
  ('Beach Chairs & Umbrella','Beach Chairs','outdoor','each',7,'smart','guest_consumable',1),
  ('Beach Towels','Beach Towels','outdoor','each',14,'smart','guest_consumable',2),
  ('Blender','Blender','kitchen','each',1,'static',NULL,1),
  ('Body Wash','Body Wash Bulk','bath','bottles',2,'static',NULL,1),
  ('Bottled Water','Bottled Water','guest_experience','packs',1,'static',NULL,1),
  ('Broom and Dustpan','Broom and Dustpan','cleaning','each',2,'static',NULL,1),
  ('Bug Spray','Bug Spray','outdoor','bottles',2,'static',NULL,1),
  ('Charcoal','Charcoal','outdoor','packs',1,'static',NULL,1),
  ('Chef Knife Block & Cutting Boards','Chef Knife Block','kitchen','each',1,'static',NULL,1),
  ('Chocolates or Mints','Chocolates or Mints','guest_experience','packs',1,'static',NULL,1),
  ('Coat Hangers','Coat Hangers','bedroom_linens','each',44,'smart','bedroom_essential',12),
  ('Coffee','Coffee','kitchen','packs',1,'static',NULL,1),
  ('Coffee Filters','Coffee Filters','kitchen','packs',1,'static',NULL,1),
  ('Coffee Maker / Keurig','Coffee Maker / Keurig','kitchen','each',1,'static',NULL,1),
  ('Coffee Welcome Kit','Coffee Welcome Pack','guest_experience','each',4,'static',NULL,1),
  ('Command Strips and Hooks','Command Strips','maintenance_safety','packs',2,'static',NULL,1),
  ('Conditioner','Conditioner Bulk','bath','bottles',2,'static',NULL,1),
  ('Cookware Set','Cookware Set','kitchen','each',1,'static',NULL,1),
  ('Cotton Balls / Swabs','Cotton Balls / Swabs','bath','packs',1,'static',NULL,1),
  ('Dinnerware Set / Plates','Dinnerware Set / Plates','kitchen','each',14,'smart','guest_consumable',2),
  ('Dish Cloths and Towels','Dish Cloths and Towels','kitchen','each',4,'static',NULL,1),
  ('Dish Soap','Dish Soap','cleaning','bottles',1,'static',NULL,1),
  ('Dishwasher Pods','Dishwasher Pods','cleaning','packs',1,'static',NULL,1),
  ('Disinfecting Wipes','Disinfecting Wipes','cleaning','packs',1,'static',NULL,1),
  ('Disposable Razors','Disposable Razor','bath','each',5,'smart','bathroom_essential',2),
  ('Drinking Glasses & Mugs','Drinking Glasses','kitchen','each',14,'smart','guest_consumable',2),
  ('Dryer Sheets','Dryer Sheets','laundry','packs',1,'static',NULL,1),
  ('Dryer Vent Brush','Dryer Vent Brush','laundry','each',1,'static',NULL,1),
  ('Duct Tape','Duct Tape','maintenance_safety','each',2,'static',NULL,1),
  ('Duvet Cover','Duvet Cover','bedroom_linens','each',8,'smart','bedroom_essential',2),
  ('Duvet Insert / Comforter','Duvet Insert / Comforter','bedroom_linens','each',4,'smart','bedroom_essential',1),
  ('Extra Pillow Cases','Extra Pillow Cases','bedroom_linens','each',8,'smart','bedroom_essential',2),
  ('Extra Sheet Set','Extra Sheet Set','bedroom_linens','each',4,'smart','bedroom_essential',1),
  ('Extra Throw Blanket','Extra Throw Blanket','bedroom_linens','each',3,'static',NULL,1),
  ('Facial Tissues','Facial Tissues','paper_goods','packs',5,'smart','bathroom_essential',2),
  ('Fire Extinguisher','Fire Extinguisher','maintenance_safety','each',2,'static',NULL,1),
  ('Fire Pit Tool Set','Fire Pit Tool Set','outdoor','each',1,'static',NULL,1),
  ('Fire Starters','Fire Starters','outdoor','each',4,'static',NULL,1),
  ('Firewood Bundle','Firewood Bundle','outdoor','each',4,'static',NULL,1),
  ('First Aid Kit','First Aid Kit','maintenance_safety','each',1,'static',NULL,1),
  ('Flatware Set','Flatware Set','kitchen','each',14,'smart','guest_consumable',2),
  ('Floor Cleaner Solution','Floor Cleaner Solution','cleaning','bottles',1,'static',NULL,1),
  ('Furniture Polish','Furniture Polish','cleaning','bottles',1,'static',NULL,1),
  ('Glass Cleaner','Glass Cleaner','cleaning','bottles',1,'static',NULL,1),
  ('Grill Brush','Grill Brush','outdoor','each',2,'static',NULL,1),
  ('Guest Book','Guest Book','guest_experience','each',1,'static',NULL,1),
  ('HDMI Cable','HDMI Cable','technology','each',2,'static',NULL,1),
  ('HVAC Air Filters','HVAC Air Filters','maintenance_safety','each',4,'static',NULL,1),
  ('Hair Dryer','Hair Dryer','bath','each',3,'smart','bathroom_essential',1),
  ('Hand Soap','Hand Soap Bulk','bath','bottles',2,'static',NULL,1),
  ('Hand Towels','Hand Towels','bath','each',7,'smart','bathroom_essential',3),
  ('Hot Cocoa Packets','Hot Cocoa Packets','kitchen','packs',1,'static',NULL,1),
  ('Hot Tub Test Kit & Chemicals','Hot Tub Test Kit & Strips','outdoor','packs',1,'static',NULL,1),
  ('Laundry Detergent','Laundry Detergent/Pods','laundry','bottles',1,'static',NULL,1),
  ('Light Bulbs LED A19','Light Bulbs LED A19','maintenance_safety','each',12,'static',NULL,1),
  ('Light Bulbs LED BR30','Light Bulbs LED BR30','maintenance_safety','each',6,'static',NULL,1),
  ('Lightning Cable','Lightning Cable','technology','each',3,'static',NULL,1),
  ('Local Maps and Brochures','Local Maps and Event Guides','guest_experience','each',4,'static',NULL,1),
  ('Local Snack Assortment','Local Snack Assortment','guest_experience','each',4,'static',NULL,1),
  ('Luggage Racks','Luggage Racks','bedroom_linens','each',4,'smart','bedroom_essential',1),
  ('Makeup Remover Wipes','Makeup Remover Wipes','bath','packs',3,'smart','bathroom_essential',1),
  ('Makeup Towels','Makeup Towels','bath','each',7,'smart','bathroom_essential',3),
  ('Mattress Protector','Mattress Protector','bedroom_linens','each',4,'smart','bedroom_essential',1),
  ('Mesh Laundry Bags','Mesh Laundry Bags','laundry','each',2,'static',NULL,1),
  ('Microfiber Cloths','Microfiber Cloths','cleaning','each',12,'static',NULL,1),
  ('Microwave','Microwave','kitchen','each',1,'static',NULL,1),
  ('Mop Heads','Mop Heads','cleaning','each',4,'static',NULL,1),
  ('Napkins','Napkins','paper_goods','packs',2,'static',NULL,1),
  ('Night Light','Night Light','bath','each',3,'smart','bathroom_essential',1),
  ('Outdoor Drinkware','Outdoor Drinkware','kitchen','each',14,'smart','guest_consumable',2),
  ('Paper Cups','Paper Cups','paper_goods','each',20,'static',NULL,1),
  ('Paper Plates','Paper Plates','paper_goods','packs',2,'static',NULL,1),
  ('Paper Towels','Paper Towels','paper_goods','rolls',10,'static',NULL,1),
  ('Patio String Light Bulbs','Patio String Light Bulbs','outdoor','each',8,'static',NULL,1),
  ('Pepper','Pepper','kitchen','each',2,'static',NULL,1),
  ('Pillow Protectors','Pillow Protectors','bedroom_linens','each',15,'smart','bedroom_essential',4),
  ('Plunger Set','Plunger Set','bath','each',3,'smart','bathroom_essential',1),
  ('Pool Shock and Chemicals','Pool Shock and Chemicals','outdoor','each',1,'static',NULL,1),
  ('Pool Towels','Pool Towels','outdoor','each',14,'smart','guest_consumable',2),
  ('Power Strip','Power Strip','technology','each',2,'static',NULL,1),
  ('Propane Tank','Propane Tank','outdoor','each',2,'static',NULL,1),
  ('Rubber Gloves','Rubber Gloves','cleaning','packs',2,'static',NULL,1),
  ('Salt','Salt','kitchen','each',2,'static',NULL,1),
  ('Scrub Brushes','Scrub Brushes','cleaning','each',2,'static',NULL,1),
  ('Shampoo','Shampoo Bulk','bath','bottles',2,'static',NULL,1),
  ('Smart Bulbs','Smart Bulbs','maintenance_safety','each',4,'static',NULL,1),
  ('Spare Pillows','Spare Pillows','bedroom_linens','each',8,'smart','bedroom_essential',2),
  ('Sponges','Sponges','cleaning','each',6,'static',NULL,1),
  ('Stain Remover','Stain Remover','laundry','bottles',2,'static',NULL,1),
  ('Sugar','Sugar Packets','kitchen','packs',2,'static',NULL,1),
  ('Sweetener Packets','Sweetener Packets','kitchen','packs',2,'static',NULL,1),
  ('Toaster','Toaster','kitchen','each',1,'static',NULL,1),
  ('Toilet Bowl Cleaner','Toilet Bowl Cleaner','cleaning','bottles',2,'static',NULL,1),
  ('Toilet Brush','Toilet Brush & Caddy','cleaning','each',3,'smart','bathroom_essential',1),
  ('Toilet Paper','Toilet Paper','paper_goods','rolls',18,'static',NULL,1),
  ('Toothbrush and Paste Kit','Toothbrush and Toothpaste Kit','bath','each',5,'smart','bathroom_essential',2),
  ('Toothpicks','Toothpicks','kitchen','packs',1,'static',NULL,1),
  ('Trash Bags - Kitchen','Trash Bags - Kitchen','cleaning','packs',2,'static',NULL,1),
  ('USB-A Charging Cable','USB-A Charging Cable','technology','each',2,'static',NULL,1),
  ('USB-C Charging Cable','USB-C Charging Cable','technology','each',3,'static',NULL,1),
  ('Universal TV Remote Control','Universal TV Remote','technology','each',2,'static',NULL,1),
  ('Vacuum Bags or Filters','Vacuum Bags or Filters','cleaning','each',1,'static',NULL,1),
  ('Washcloths','Washcloths','bath','each',12,'smart','bathroom_essential',5),
  ('Washer Cleaning Tablets','Washer Cleaning Tablets','laundry','packs',2,'static',NULL,1),
  ('Wine Opener & Peeler Set','Wine Opener & Bottle Opener','kitchen','each',2,'static',NULL,1)
) AS v(old_name,new_name,category,unit,par,mode,grp,bq)
WHERE c.name = v.old_name;

INSERT INTO public.inventory_catalog
  (name, category, default_unit, description, default_par_level, par_mode, smart_group, base_qty)
SELECT v.name, v.category::inventory_category, v.unit, v.description, v.par,
       v.mode::par_mode, v.grp::par_smart_group, v.bq
FROM (VALUES
  ('3 in 1 shower dispenser','bath','each','shampoo, conditioner, body wash dispenser',3,'smart','bathroom_essential',1),
  ('CO/CO2 Detectors','maintenance_safety','each','One per bedroom + kitchen + living room',4,'smart','bedroom_essential',1),
  ('Can Opener','kitchen','each','Replace when missing or broken',1,'static',NULL,1),
  ('Coffee K-Cup','kitchen','each','Single cup for keurig machines',27,'smart','guest_consumable',4),
  ('Flashlight','maintenance_safety','each','For emergencies/power outages',3,'static',NULL,1),
  ('Garmet Steamer','laundry','each',NULL,1,'static',NULL,1),
  ('Iron','laundry','each',NULL,1,'static',NULL,1),
  ('Ironing Board','laundry','each',NULL,1,'static',NULL,1),
  ('Measuring Cup Set','kitchen','each',NULL,1,'static',NULL,1),
  ('Measuring Spoon Set','kitchen','each',NULL,1,'static',NULL,1),
  ('Mop Handles','cleaning','each',NULL,2,'static',NULL,1),
  ('Pool Salt','outdoor','packs','For salt water pools only',4,'static',NULL,1),
  ('Screwdriver','maintenance_safety','each',NULL,2,'static',NULL,1),
  ('Thermacell','outdoor','each','Mosquito deterrent',2,'static',NULL,1),
  ('Trash Bags - Small','cleaning','packs','small bathroom trash bags',2,'static',NULL,1),
  ('WD-40','maintenance_safety','each',NULL,1,'static',NULL,1),
  ('Wine Glasses','kitchen','each',NULL,7,'smart','guest_consumable',1),
  ('Wrench','maintenance_safety','each',NULL,2,'static',NULL,1),
  ('hand soap dispenser','bath','each','dispenser for hand soap next to the sink',3,'smart','bathroom_essential',1)
) AS v(name,category,unit,description,par,mode,grp,bq)
WHERE NOT EXISTS (SELECT 1 FROM public.inventory_catalog c WHERE c.name = v.name);

UPDATE public.inventory_catalog c SET default_par_level = v.par
FROM (VALUES
  ('Bottle Opener and Corkscrew',1),
  ('Citronella Candles',2),
  ('Cocktail Napkins',2),
  ('Coffee Creamer',2),
  ('Cooking Oil',1),
  ('Disposable Cutlery Set',2),
  ('Fabric Softener',1),
  ('Grout Cleaner',1),
  ('Lighter Fluid',1),
  ('Lotion',2),
  ('Matches',2),
  ('Mildew Remover',1),
  ('Plastic Wrap',1),
  ('Snow Shovels & Ice Melt',1),
  ('Sunscreen',2),
  ('Surge Protector Strip',2),
  ('Tea Bags',1),
  ('Trash Bags - Large',2),
  ('Welcome Cards',4)
) AS v(name,par)
WHERE c.name = v.name;
