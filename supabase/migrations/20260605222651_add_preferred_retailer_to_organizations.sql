
-- Add preferred shopping retailer to organizations.
-- Drives which cart API the Inngest shopping function uses.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS preferred_retailer TEXT DEFAULT 'walmart'
    CHECK (preferred_retailer IN ('walmart', 'kroger', 'amazon_business', 'none'));

COMMENT ON COLUMN organizations.preferred_retailer IS
  'Preferred retailer for automated cart generation from below-par purchase lists.
   walmart         = Walmart Product API (Affiliate program key required)
   kroger          = Kroger Developer API — also covers Ralphs, King Soopers,
                     Fred Meyer, Harris Teeter, Frys, Marianos, QFC, Dillons, etc.
   amazon_business = Amazon Business API (enterprise only, future)
   none            = No cart integration, generate formatted list only';
