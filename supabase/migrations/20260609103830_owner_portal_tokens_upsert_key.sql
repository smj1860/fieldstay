-- Add full unique constraint on (property_owner_id, is_multi) to enable
-- PostgREST upsert — the partial indexes alone aren't enough for on_conflict.
ALTER TABLE public.owner_portal_tokens
  ADD CONSTRAINT owner_portal_tokens_owner_type_unique
  UNIQUE (property_owner_id, is_multi);
