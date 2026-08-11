-- Retire 14 items from the platform inventory catalog.
--
-- Owner decision (2026-08-11), reviewing the FieldStay catalog against the
-- standard-inventory seed sheet. These are being removed from the platform
-- catalog outright, not deactivated: they should not reach any new org.
--
--   Decorative Candles            Mouthwash
--   Touch-Up Paint & Wall Patch   Bath Salts or Epsom Salt
--   Zip Lock Bags                 Shower Caps
--   Parchment Paper               Dental Floss
--   Air Freshener Spray           Feminine Hygiene Products
--   Drain Unclogger               Pain Reliever Packets  ┐ superseded by the
--   Stainless Steel Cleaner       Band-Aids Assorted     ┘ existing First Aid Kit
--
-- Deliberately NOT in this list, though the seed sheet omits them: the owner
-- confirmed `Trash Bags - Large` and `Bottle Opener and Corkscrew` are real
-- items to keep.
--
-- ── What this DELETE does and does not do ──────────────────────────────────
-- Checked against the live FK graph before writing, not assumed:
--
--   inventory_items.catalog_item_id                   ON DELETE SET NULL
--   inventory_template_items.catalog_item_id          ON DELETE SET NULL
--   org_inventory_catalog.platform_catalog_item_id    ON DELETE SET NULL
--   platform_inventory_template_items.catalog_item_id ON DELETE RESTRICT
--
-- None of the 14 is referenced by platform_inventory_template_items, so the
-- RESTRICT arm cannot block this. The three SET NULL arms mean rows that
-- already reference these items SURVIVE and merely lose the link: at time of
-- writing, 15 property-level inventory_items across 3 orgs and 13
-- org_inventory_catalog copies in 1 org. Those become unlinked custom items
-- and REMAIN VISIBLE to their org — deleting the platform row stops these
-- items reaching NEW orgs; it does not retroactively clean the org that
-- already copied them. Cleaning those is a separate, owner-directed decision
-- because they are a PM's live inventory records, not platform seed data.
--
-- Idempotent by construction: DELETE ... WHERE name IN (...) is a no-op on a
-- project where it has already run.

DELETE FROM public.inventory_catalog
WHERE name IN (
  'Decorative Candles',
  'Touch-Up Paint & Wall Patch',
  'Zip Lock Bags',
  'Parchment Paper',
  'Air Freshener Spray',
  'Drain Unclogger',
  'Stainless Steel Cleaner',
  'Mouthwash',
  'Bath Salts or Epsom Salt',
  'Shower Caps',
  'Dental Floss',
  'Feminine Hygiene Products',
  'Pain Reliever Packets',
  'Band-Aids Assorted'
);
