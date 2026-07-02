-- This migration is a no-op for this schema.
--
-- The instruction file assumed integration_connections had VARCHAR(255) columns
-- for access_token and refresh_token. In practice, tokens are stored in Supabase
-- Vault (vault_secret_id, refresh_token_vault_secret_id), so there is no length
-- constraint to widen. No DDL changes are needed.
SELECT 1;
