
-- ================================================================
-- Add preferred_brand to inventory_template_items and inventory_items.
--
-- Two tiers:
--   inventory_template_items.preferred_brand  = org-level default
--   inventory_items.preferred_brand           = property-level override
--     (NULL = inherit from template brand, empty string = no preference)
--
-- Kroger cart builder uses: COALESCE(item.preferred_brand, template.preferred_brand)
-- to build the search query. "paper towels" + "Bounty" → "Bounty paper towels"
-- ================================================================

ALTER TABLE inventory_template_items
  ADD COLUMN IF NOT EXISTS preferred_brand TEXT DEFAULT NULL;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS preferred_brand TEXT DEFAULT NULL;

COMMENT ON COLUMN inventory_template_items.preferred_brand IS
  'Org-level default brand for this inventory item.
   Used as the base search term when building Kroger shopping carts.
   Example: "Bounty" → search query becomes "Bounty paper towels".
   Property-level inventory_items.preferred_brand overrides this.';

COMMENT ON COLUMN inventory_items.preferred_brand IS
  'Property-specific brand override. Takes precedence over the template brand.
   NULL = inherit from inventory_template_items.preferred_brand.
   Set this when a specific property has different brand requirements
   (owner preference, guest feedback, etc.).';

-- Ensure the apply-template-to-properties action copies the brand
-- This index helps the brand lookup when building carts across all properties
CREATE INDEX IF NOT EXISTS idx_inventory_items_brand
  ON inventory_items(org_id, preferred_brand)
  WHERE preferred_brand IS NOT NULL;
