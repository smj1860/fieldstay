-- Register Hospitable as an OAuth2 integration provider so it uses
-- the existing /api/integrations/[provider]/connect|callback routes
-- and Vault-backed token storage. Same pattern as OwnerRez/Kroger.
INSERT INTO public.integration_providers (id, display_name, auth_type, is_active)
VALUES ('hospitable', 'Hospitable', 'oauth2', true)
ON CONFLICT (id) DO NOTHING;
