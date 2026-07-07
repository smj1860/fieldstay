-- Document Vault RPC access control in version-controlled migration.
-- Verified 2026-06-25: service_role-only; anon/authenticated have no execute.

REVOKE EXECUTE ON FUNCTION public.store_integration_token(uuid, text, text, text, text, jsonb)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.read_integration_token(uuid, text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.revoke_integration_token(uuid, text)
  FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.store_integration_token(uuid, text, text, text, text, jsonb)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.read_integration_token(uuid, text)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.revoke_integration_token(uuid, text)
  TO service_role;
