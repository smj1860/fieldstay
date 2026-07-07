
-- Add external tracking columns to properties
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS external_id     text,
  ADD COLUMN IF NOT EXISTS external_source text;

CREATE UNIQUE INDEX IF NOT EXISTS properties_external_id_source_idx
  ON public.properties (external_id, external_source)
  WHERE external_id IS NOT NULL;

-- Add external tracking columns to bookings
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS external_id     text,
  ADD COLUMN IF NOT EXISTS external_source text;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_id_source_idx
  ON public.bookings (external_id, external_source)
  WHERE external_id IS NOT NULL;

-- Data API grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.properties TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookings   TO anon, authenticated;
