ALTER TABLE owner_portal_tokens
  ADD COLUMN IF NOT EXISTS property_ids UUID[]  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_multi     BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN owner_portal_tokens.property_ids IS
  'For multi-property tokens: array of property UUIDs this token covers.
   NULL for single-property tokens (the linked property_owners.property_id is used instead).';
COMMENT ON COLUMN owner_portal_tokens.is_multi IS
  'True = this token covers multiple properties (property_ids array).
   False = single-property token (original behavior).';
