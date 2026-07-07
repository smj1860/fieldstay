
-- Kroger requires a locationId for product availability + pricing.
-- PM connects their nearest store once; all product searches use it.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kroger_location_id        TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS kroger_location_name      TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS kroger_customer_token     TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS kroger_token_expires_at   TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS kroger_refresh_token      TEXT    DEFAULT NULL;

COMMENT ON COLUMN organizations.kroger_location_id IS
  'Kroger chain locationId for product search and cart operations.
   Set when PM connects their Kroger account or manually selects store.
   Required for accurate product availability and pricing.';
COMMENT ON COLUMN organizations.kroger_customer_token IS
  'Encrypted customer OAuth access token. Required for cart.basic:write scope.
   Obtained when PM connects their personal Kroger account to FieldStay.
   NULL = no cart automation; fall back to product search list only.';
