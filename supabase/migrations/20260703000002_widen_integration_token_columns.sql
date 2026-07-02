-- Widen integration_connections token columns to TEXT.
-- Required for Hospitable OAuth tokens which exceed VARCHAR(255) length.
-- access_token ~1,200 chars, refresh_token ~1,000 chars per Hospitable docs.
-- This is a no-op if columns are already TEXT.
ALTER TABLE public.integration_connections
  ALTER COLUMN access_token  TYPE TEXT,
  ALTER COLUMN refresh_token TYPE TEXT;
