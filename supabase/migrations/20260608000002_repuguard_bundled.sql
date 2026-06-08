-- RepuGuard is no longer a free-trial add-on with its own Stripe subscription —
-- it is now bundled into every FieldStay plan, exclusive to OwnerRez-connected accounts.

-- Migrate all existing trial orgs to active (RepuGuard is now bundled)
UPDATE public.organizations
SET repuguard_status = 'active'
WHERE repuguard_status = 'trial';

-- Clear trial date columns (retain columns for schema compat — see notes below)
UPDATE public.organizations
SET
  repuguard_trial_start = NULL,
  repuguard_trial_end   = NULL
WHERE repuguard_status = 'active'
  AND repuguard_trial_start IS NOT NULL;

-- NOTE: Do not drop repuguard_trial_start/end — keep them nullable for backward compat.
-- NOTE: Do not drop repuguard_stripe_subscription_id — referenced in
-- app/api/account/delete/route.ts for cancellation on account deletion.
-- Leave it; just stop writing to it for new activations.
