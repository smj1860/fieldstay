
-- Enum values must be committed in a separate transaction before use
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'bedroom_linens'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'inventory_category')) THEN
    ALTER TYPE inventory_category ADD VALUE 'bedroom_linens';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'maintenance_safety'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'inventory_category')) THEN
    ALTER TYPE inventory_category ADD VALUE 'maintenance_safety';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'guest_experience'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'inventory_category')) THEN
    ALTER TYPE inventory_category ADD VALUE 'guest_experience';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'technology'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'inventory_category')) THEN
    ALTER TYPE inventory_category ADD VALUE 'technology';
  END IF;
END $$;
