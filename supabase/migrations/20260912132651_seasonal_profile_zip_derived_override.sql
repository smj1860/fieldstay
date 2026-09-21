-- ============================================================================
-- seasonal_profile becomes a nullable OVERRIDE; the ZIP is the source of truth
--
-- The profile describes a MARKET, not a house, so it is derived from the
-- property's ZIP at scoring time (lib/scoring/seasonal-market.ts). Asking a PM
-- to classify each property was the wrong mechanism: this product exists to
-- take that upkeep off them.
--
-- The column stays, as the correction path. NULL now means "derive from ZIP";
-- a non-null value is a deliberate human override and always wins.
--
-- NOT NULL DEFAULT 'none' could not express that. Every one of the existing
-- rows holds 'none' because that was the default, not because anyone chose it
-- — so "unset" and "deliberately no seasonality" were the same value, and the
-- derivation would have had no way to tell whose answer it was overruling.
-- This is the same distinction properties.sponsor_assignment_mode exists to
-- preserve (20260903152756), arrived at the same way.
-- ============================================================================

ALTER TABLE public.properties
  ALTER COLUMN seasonal_profile DROP DEFAULT,
  ALTER COLUMN seasonal_profile DROP NOT NULL;

-- Safe precisely because nothing has ever written this column: it was added
-- 2026-09-12 with no UI and no writer, so every 'none' in the table is the
-- default rather than a choice. Scoped to 'none' anyway, so a value set
-- between that migration and this one would survive.
UPDATE public.properties
   SET seasonal_profile = NULL
 WHERE seasonal_profile = 'none';

COMMENT ON COLUMN public.properties.seasonal_profile IS
  'OVERRIDE ONLY. NULL = derive the market profile from the ZIP via
   lib/scoring/seasonal-market.ts, which is the normal case. A non-null value
   is a deliberate human correction and wins over the derivation. Fixed MM-DD
   windows — a rough internal ops proxy, never a customer-facing precision
   claim.';
