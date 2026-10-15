-- How many days after checkout a damage claim can still be filed on platforms
-- with no policy window of their own (direct, manual, other). Airbnb and VRBO
-- carry their own rules in lib/evidence/packet/deadlines.ts. The org setting is
-- the fallback and the PM's own house rule for everything else.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS claim_window_days integer NOT NULL DEFAULT 14;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_claim_window_days_range;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_claim_window_days_range
    CHECK (claim_window_days BETWEEN 1 AND 365);

COMMENT ON COLUMN public.organizations.claim_window_days IS
  'Days after checkout a damage claim can be filed on platforms with no window of their own (direct, manual, other). Default 14.';
