-- RepuGuard is included in every plan. The standalone subscription model was
-- dropped long ago (nothing in the codebase creates a `feature: 'repuguard'`
-- Stripe subscription any more, and its two webhook handlers were deleted in
-- the same change as this migration), but organizations.repuguard_status was
-- left behind still gating the feature:
--
--   * app/api/repuguard/generate/route.ts     403 unless status = 'active'
--   * app/(dashboard)/reviews/actions.ts      refuses unless status = 'active'
--   * app/(dashboard)/layout.tsx              hides the nav item
--
-- and the column DEFAULTs to 'inactive'. The only thing that ever set it to
-- 'active' was the OwnerRez initial-sync auto-activate step, so any org that
-- never connected OwnerRez was locked out of a feature they were paying for.
-- On production at the time of writing that was 6 of 8 orgs.
--
-- The gates are removed in code in the same change. This migration makes the
-- stored data agree: every existing org is activated, and the default is
-- flipped so new orgs are active on creation rather than depending on an
-- integration connect that may never happen.
--
-- The column and its CHECK constraint are deliberately KEPT rather than
-- dropped. It is now vestigial for entitlement, but dropping it would touch
-- types/database.ts, the generated types, and lib/auth.ts's OrgMembership in
-- the same breath as a behaviour change; that belongs in its own cleanup.

ALTER TABLE public.organizations
  ALTER COLUMN repuguard_status SET DEFAULT 'active';

UPDATE public.organizations
   SET repuguard_status = 'active'
 WHERE repuguard_status IS DISTINCT FROM 'active';

COMMENT ON COLUMN public.organizations.repuguard_status IS
  'VESTIGIAL for entitlement — RepuGuard ships with every plan and no code path gates on this column any more. Retained only so historical rows and the CHECK constraint stay intact.';
