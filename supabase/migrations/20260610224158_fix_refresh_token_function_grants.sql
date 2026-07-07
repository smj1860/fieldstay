-- store_integration_refresh_token / read_integration_refresh_token were
-- created without explicit grants, so Postgres defaulted to EXECUTE granted
-- to PUBLIC (including anon/authenticated via PostgREST RPC). Lock these
-- down to match store_integration_token / read_integration_token, which are
-- service-role only.
REVOKE EXECUTE ON FUNCTION public.store_integration_refresh_token(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.read_integration_refresh_token(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.store_integration_refresh_token(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_integration_refresh_token(uuid, text) TO service_role;
