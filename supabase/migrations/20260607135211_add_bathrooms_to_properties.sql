ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS bathrooms NUMERIC(4,1);

COMMENT ON COLUMN properties.bathrooms IS
  'Number of bathrooms. Accepts half-baths (e.g. 2.5).
   Auto-populated from OwnerRez or Uplisting on OAuth sync
   if currently NULL. Never overwritten after PM manual entry.';
