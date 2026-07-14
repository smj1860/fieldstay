-- Generic service-role-only helper to destroy a Vault secret by id.
-- Used by the guest-PII retention cron to purge booking-level door-code
-- secrets once a booking's guest PII has aged out (no per-table RPC exists
-- for bookings.door_code_secret_id yet since no integration writes it).
CREATE OR REPLACE FUNCTION public.delete_vault_secret(p_secret_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  DELETE FROM vault.secrets WHERE id = p_secret_id;
$$;

REVOKE ALL ON FUNCTION public.delete_vault_secret(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_vault_secret(uuid) TO service_role;
