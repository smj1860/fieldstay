-- Per-connection inbound webhook identity.
--
-- webhook_token is the path segment of the URL FieldStay registers with the
-- provider (/api/webhooks/hostex/<token>). It exists because Hostex gives no
-- other way to tell which connection an inbound delivery belongs to: the
-- payload carries only a property_id, and resolving a TENANT from a
-- provider-side object id means trusting that ids never collide across
-- accounts. A distinct URL per connection makes that resolution structural
-- instead of inferential.
--
-- webhook_secret_hash is the SHA-256 of the Hostex-Webhook-Secret-Token header
-- that arrives on the FIRST delivery. Hostex never returns this value from any
-- API — not from POST /webhooks, not from GET /webhooks — so trust-on-first-use
-- is the only mechanism available. A HASH, not the secret: verification only
-- needs to compare, so the plaintext is never stored.
--
-- Both are generic (not hostex_-prefixed) because the shape is not
-- Hostex-specific: any provider whose secret is per-connection rather than a
-- global env var needs exactly this pair.
ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS webhook_token       text,
  ADD COLUMN IF NOT EXISTS webhook_secret_hash text;

-- Partial unique: the token is the sole routing key for an unauthenticated
-- inbound request, so two connections sharing one would silently cross tenants.
-- Partial because every non-Hostex connection leaves it NULL.
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_webhook_token_uniq
  ON public.integration_connections (webhook_token)
  WHERE webhook_token IS NOT NULL;
