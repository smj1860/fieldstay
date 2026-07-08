-- Prepare integration_connections for providers that issue refresh tokens.
-- NULL for providers without expiring tokens (e.g. OwnerRez). No code change
-- needed until a refresh-token provider is actually onboarded.
ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS refresh_token_vault_secret_id uuid,
  ADD COLUMN IF NOT EXISTS expires_at                    timestamptz;

COMMENT ON COLUMN public.integration_connections.refresh_token_vault_secret_id IS
  'FK → vault.secrets.id for the refresh token. NULL for non-expiring providers (e.g. OwnerRez).';

COMMENT ON COLUMN public.integration_connections.expires_at IS
  'When the access token expires. NULL for non-expiring tokens.';
