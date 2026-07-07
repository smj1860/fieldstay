-- Register Kroger as a generic OAuth2 integration provider so it can use
-- the existing /api/integrations/[provider]/connect|callback routes and
-- Vault-backed token storage, instead of the bespoke /api/kroger/* routes.
INSERT INTO public.integration_providers (id, display_name, auth_type, is_active)
VALUES ('kroger', 'Kroger', 'oauth2', true)
ON CONFLICT (id) DO NOTHING;
