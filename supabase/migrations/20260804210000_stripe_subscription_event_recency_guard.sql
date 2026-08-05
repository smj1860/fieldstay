-- Closes a stale-replay hole in handleCoreSubscriptionUpdate (core-billing.ts).
--
-- 20260730140000 added the FOR UPDATE row lock, which makes two CONCURRENT
-- deliveries for the same org serialize correctly. It does not — and cannot —
-- tell a NEWER event from an OLDER one. Stripe does not guarantee delivery
-- order and retries a failed delivery with backoff for up to ~3 days, so:
--
--   1. customer.subscription.updated (trialing -> active) fails on a deploy
--      blip and enters Stripe's retry schedule.
--   2. The customer's card then fails. customer.subscription.updated
--      (active -> past_due) is delivered and applied.
--   3. The retry from (1) lands and writes plan_status 'active' back.
--
-- The org regains full entitlement on a failed card, permanently — nothing
-- corrects it until the next subscription event happens to fire.
--
-- The guard is a monotonic precondition on the org's last-applied Stripe event
-- timestamp, evaluated in the same statement as the write (not as an `if`
-- above it, which would be the same TOCTOU the row lock already closed).
--
-- DELIBERATELY BACKWARD COMPATIBLE IN BOTH DIRECTIONS, so this can be applied
-- before the code that passes p_event_at ships:
--   * p_event_at DEFAULT NULL — a 6-argument call from the currently-deployed
--     code still resolves, and NULL means "no recency information", which
--     applies unconditionally exactly as today.
--   * The extra `applied` return column is additive; the old caller casts the
--     row to a 3-field shape and ignores it.
--
-- The signature changes, so this is DROP + CREATE rather than CREATE OR
-- REPLACE (Postgres cannot change a function's return type in place, and
-- adding an argument would otherwise create a second overload that PostgREST
-- could not disambiguate).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_event_at timestamptz;

COMMENT ON COLUMN public.organizations.stripe_event_at IS
  'created timestamp of the most recent Stripe subscription event applied to this row. Used to reject out-of-order/retried deliveries — see update_organization_subscription_from_stripe.';

DROP FUNCTION IF EXISTS public.update_organization_subscription_from_stripe(
  text, text, public.org_plan, public.org_plan_status, int, timestamptz
);

CREATE OR REPLACE FUNCTION public.update_organization_subscription_from_stripe(
  p_customer_id            text,
  p_stripe_subscription_id text,
  p_plan                   public.org_plan,
  p_plan_status            public.org_plan_status,
  p_max_properties         int,
  p_trial_ends_at          timestamptz,
  p_event_at               timestamptz DEFAULT NULL
)
RETURNS TABLE (
  org_id        uuid,
  org_name      text,
  previous_plan public.org_plan,
  applied       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id         uuid;
  v_org_name       text;
  v_previous_plan  public.org_plan;
  v_last_event_at  timestamptz;
BEGIN
  SELECT o.id, o.name, o.plan, o.stripe_event_at
  INTO v_org_id, v_org_name, v_previous_plan, v_last_event_at
  FROM public.organizations o
  WHERE o.stripe_customer_id = p_customer_id
  FOR UPDATE;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  -- Stale delivery: an event older than the last one applied to this row.
  -- `>=` rather than `>` on purpose — Stripe's `created` has one-second
  -- granularity, so two DISTINCT events can share a timestamp, and `>` would
  -- silently drop the second one. Re-applying an identical event is harmless.
  IF p_event_at IS NOT NULL
     AND v_last_event_at IS NOT NULL
     AND p_event_at < v_last_event_at
  THEN
    RETURN QUERY SELECT v_org_id, v_org_name, v_previous_plan, false;
    RETURN;
  END IF;

  UPDATE public.organizations
  SET
    stripe_subscription_id = p_stripe_subscription_id,
    plan                   = p_plan,
    plan_status            = p_plan_status,
    max_properties         = p_max_properties,
    trial_ends_at          = p_trial_ends_at,
    -- COALESCE keeps a previously-recorded timestamp when a legacy 6-argument
    -- call passes no event time, rather than erasing the guard.
    stripe_event_at        = COALESCE(p_event_at, v_last_event_at)
  WHERE id = v_org_id;

  RETURN QUERY SELECT v_org_id, v_org_name, v_previous_plan, true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_organization_subscription_from_stripe(
  text, text, public.org_plan, public.org_plan_status, int, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_organization_subscription_from_stripe(
  text, text, public.org_plan, public.org_plan_status, int, timestamptz, timestamptz
) TO service_role;
