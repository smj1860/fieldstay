-- Master list v2: reconcile the platform catalog with the owner's revised
-- seed sheet. 152 -> 157.
--
-- Only the 16 rows that actually change are touched. 141 of the 152 live rows
-- already match the new sheet exactly (category, unit, par, par_mode,
-- smart_group, base_qty), so rewriting them would be churn in the diff and in
-- the audit trail for no schema or data effect.
--
-- FIVE OF THESE ARE RENAMES, not delete-and-recreate. Each was confirmed by
-- matching BOTH the description and the par against the live row, not guessed
-- from name similarity:
--   Light Bulbs LED A19   -> Replacement Light Bulbs      (par 12, "Standard base — most lamps")
--   Light Bulbs LED BR30  -> Recessed/Other Light Bulbs   (par 6,  "Recessed and flood lights")
--   Mop Handles           -> Swiffer Mop                  (product swap, same function)
--   Mop Heads             -> Swiffer Refills              (product swap, same function)
--   Coffee Creamer        -> Creamer Cups                 (owner-directed rename)
-- Updating in place keeps inventory_catalog.id, which matters because three of
-- the four FKs into this table are ON DELETE SET NULL: a delete-and-recreate
-- would silently unlink existing property inventory rather than erroring.
--
-- Creamer Cups is not merely renamed — it becomes SMART at 8/guest, where
-- Coffee Creamer was static par 2. Its attributes come from the workbook's
-- template tab, the only tab that carries it.
--
-- Six deliberate par reductions to 1 (Fire Extinguisher, HDMI Cable, Lightning
-- Cable, USB-A, USB-C, Universal TV Remote). Verified these are explicit 1.0
-- cells in the sheet, not blanks defaulting to 1.
--
-- NOTHING IS DELETED. The 18 catalog items absent from the sheet stay: the
-- owner confirmed the tab is the complete master list "besides the 19 items
-- currently in fieldstay but not the sheet" (19 counting Coffee Creamer, which
-- is the rename above, leaving 18 untouched). An earlier read of that gap as a
-- delete list would have removed Trash Bags - Large and Bottle Opener and
-- Corkscrew, which the owner had explicitly said they stock.
--
-- Verified before applying: no post-merge name collisions (157 unique names)
-- and no order-dependent rename hazard — no new name equals another pair's old
-- name. inventory_catalog has NO unique index on name, so both would have
-- produced duplicate or mis-targeted rows silently rather than erroring.

UPDATE public.inventory_catalog c SET
  name=v.new_name, category=v.category::inventory_category, default_unit=v.unit,
  default_par_level=v.par, par_mode=v.mode::par_mode,
  smart_group=v.grp::par_smart_group, base_qty=v.bq
FROM (VALUES
  ('Coffee Creamer','Creamer Cups','kitchen','each',53,'smart','guest_consumable',8),
  ('Fire Extinguisher','Fire Extinguisher','maintenance_safety','each',1,'static',NULL,1),
  ('HDMI Cable','HDMI Cable','technology','each',1,'static',NULL,1),
  ('Lightning Cable','Lightning Cable','technology','each',1,'static',NULL,1),
  ('Light Bulbs LED BR30','Recessed/Other Light Bulbs','maintenance_safety','each',6,'static',NULL,1),
  ('Light Bulbs LED A19','Replacement Light Bulbs','maintenance_safety','each',12,'static',NULL,1),
  ('Mop Handles','Swiffer Mop','cleaning','each',1,'static',NULL,1),
  ('Mop Heads','Swiffer Refills','cleaning','packs',2,'static',NULL,1),
  ('USB-A Charging Cable','USB-A Charging Cable','technology','each',1,'static',NULL,1),
  ('USB-C Charging Cable','USB-C Charging Cable','technology','each',1,'static',NULL,1),
  ('Universal TV Remote','Universal TV Remote','technology','each',1,'static',NULL,1)
) AS v(old_name,new_name,category,unit,par,mode,grp,bq)
WHERE c.name = v.old_name;

INSERT INTO public.inventory_catalog
  (name, category, default_unit, description, default_par_level, par_mode, smart_group, base_qty)
SELECT v.name, v.category::inventory_category, v.unit, v.description, v.par,
       v.mode::par_mode, v.grp::par_smart_group, v.bq
FROM (VALUES
  ('Cooking Spoon','kitchen','each',NULL,2,'static',NULL,1),
  ('Cutting Boards','kitchen','each',NULL,2,'static',NULL,1),
  ('Mixing Bowls','kitchen','each',NULL,2,'static',NULL,1),
  ('Oven Mitts','kitchen','each',NULL,2,'static',NULL,1),
  ('Spatula','kitchen','each',NULL,2,'static',NULL,1)
) AS v(name,category,unit,description,par,mode,grp,bq)
WHERE NOT EXISTS (SELECT 1 FROM public.inventory_catalog c WHERE c.name = v.name);
