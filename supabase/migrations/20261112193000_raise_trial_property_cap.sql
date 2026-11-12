-- ============================================================================
-- Raise the property cap on trialing organizations from 15 to the self-serve
-- ceiling (150).
--
-- New organizations were created with max_properties = 15 (the old Starter tier
-- cap, a literal in app/onboarding/actions.ts). It is enforced as a hard wall by
-- enforce_property_plan_limit(), so a trialing org importing more than 15
-- properties (an OwnerRez portfolio, say) was rejected partway through. The
-- graduated-pricing rebuild (2026-08-29) already made 150 the structural ceiling
-- for every paid org, set by the Stripe webhook; trials were never moved.
--
-- The code change (onboarding now passes MAX_SELF_SERVE_PROPERTIES) covers orgs
-- created from here on. This backfills the ones that already exist, which is
-- exactly what lib/stripe/brackets.ts and CLAUDE.md say a ceiling change needs:
-- the constant alone does not reach rows that were already written.
--
-- Narrow on purpose:
--   * max_properties = 15        only rows still at the legacy value
--   * plan_status = 'trialing'   not a paying or comped org
--   * no stripe_subscription_id  a subscribed org is the webhook's to manage
-- It raises a limit and removes nothing, so no existing property is affected.
-- Idempotent: a second run matches no rows.
-- ============================================================================

UPDATE public.organizations
SET    max_properties = 150
WHERE  max_properties = 15
  AND  plan_status = 'trialing'
  AND  stripe_subscription_id IS NULL;
