-- This migration is a no-op for this schema.
-- Tokens are stored in Supabase Vault (vault_secret_id, refresh_token_vault_secret_id),
-- not in plaintext columns — no length constraint to widen.
SELECT 1;
