-- These columns held Kroger OAuth tokens in PLAINTEXT (mislabeled "Encrypted").
-- Kroger now uses the Vault-backed integration_connections path exclusively;
-- these columns are unpopulated (0 rows) and are a standing credential-exposure
-- risk. Non-secret store-selection columns (kroger_location_id/name) are kept.
ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS kroger_customer_token,
  DROP COLUMN IF EXISTS kroger_refresh_token,
  DROP COLUMN IF EXISTS kroger_token_expires_at;

NOTIFY pgrst, 'reload schema';
