-- Closes a TOCTOU race in handleCoreSubscriptionUpdate (core-billing.ts):
-- the previous implementation did a plain SELECT to read organizations.plan
-- before a separate UPDATE, via two independent PostgREST calls with no
-- lock held between them. Two concurrent Stripe webhook deliveries for the
-- same org (a rapid double plan-change, or Stripe's own retry racing a
-- fresh delivery) could both read the same stale "previous" plan before
-- either UPDATE committed, producing an incorrect previous_plan label on
-- the billing/subscription-updated event.
--
-- PostgREST's .update() can't express "lock, read old value, write new
-- value, return old value" as one atomic round trip — there's no RETURNING
-- of a pre-update column through the REST interface. A SECURITY DEFINER
-- function is the standard fix for this shape in this codebase (see
-- claim_hospitable_promo_slot for the same FOR UPDATE row-lock pattern).
-- The FOR UPDATE lock is what makes this race-safe: a concurrent call for
-- the same org blocks here until the first transaction commits, then reads
-- the now-committed value as "previous" — never a stale pre-lock read.

CREATE OR REPLACE FUNCTION public.update_organization_subscription_from_stripe(
  p_customer_id            text,
  p_stripe_subscription_id text,
  p_plan                   public.org_plan,
  p_plan_status            public.org_plan_status,
  p_max_properties         int,
  p_trial_ends_at          timestamptz
)
RETURNS TABLE (
  org_id        uuid,
  org_name      text,
  previous_plan public.org_plan
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id        uuid;
  v_org_name      text;
  v_previous_plan public.org_plan;
BEGIN
  SELECT o.id, o.name, o.plan
  INTO v_org_id, v_org_name, v_previous_plan
  FROM public.organizations o
  WHERE o.stripe_customer_id = p_customer_id
  FOR UPDATE;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.organizations
  SET
    stripe_subscription_id = p_stripe_subscription_id,
    plan                   = p_plan,
    plan_status             = p_plan_status,
    max_properties          = p_max_properties,
    trial_ends_at            = p_trial_ends_at
  WHERE id = v_org_id;

  RETURN QUERY SELECT v_org_id, v_org_name, v_previous_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.update_organization_subscription_from_stripe(
  text, text, public.org_plan, public.org_plan_status, int, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_organization_subscription_from_stripe(
  text, text, public.org_plan, public.org_plan_status, int, timestamptz
) TO service_role;
