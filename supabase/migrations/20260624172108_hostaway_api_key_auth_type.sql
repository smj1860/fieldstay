-- Hostaway uses credential-entry (Account ID + API Key), not a browser-redirect
-- OAuth flow. Switch auth_type so the UI can route it to the credential modal
-- instead of the OAuth connect/callback redirect used by OwnerRez/Guesty.
UPDATE integration_providers
SET auth_type = 'api_key'
WHERE id = 'hostaway';
