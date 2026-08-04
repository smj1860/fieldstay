-- Removes the last three columns from the standalone RepuGuard product.
--
-- Completes what 20260804230000 started. Those two columns still had readers
-- to unwire; these three have none — grepping the whole repo (app/, lib/,
-- components/, scripts/, unit/, e2e/) finds them only in types/database.ts's
-- Organization interface and in the historical migrations that created them.
--
--   repuguard_trial_start        timestamptz  — 0 set on production, 0 on E2E
--   repuguard_trial_end          timestamptz  — 0 set on production, 0 on E2E
--   repuguard_founding_member    boolean      — 0 true on production, 0 on E2E
--
-- The trial columns were in fact already emptied years earlier in product
-- terms: 20260608122111_repuguard_bundled_activation.sql explicitly set
-- repuguard_trial_start/repuguard_trial_end to NULL when RepuGuard was folded
-- into every plan. They have been carrying nothing since.
--
-- repuguard_founding_member was held back from the previous drop on purpose —
-- a "founding member" flag can encode commercial intent (grandfathered
-- pricing, a launch cohort) that outlives whatever code once set it, and a
-- column drop is irreversible. Confirmed with the product owner before
-- dropping, with the row counts above as the evidence: no cohort exists to
-- preserve.
--
-- NOT NULL DEFAULT false on repuguard_founding_member goes with the column.

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS repuguard_trial_start,
  DROP COLUMN IF EXISTS repuguard_trial_end,
  DROP COLUMN IF EXISTS repuguard_founding_member;
