-- createOrganization (app/onboarding/actions.ts) had a check-then-act race:
-- it counted existing organization_members rows for the user, then — in a
-- separate later request — inserted the new org + membership. Two concurrent
-- submits (double-click, retry) could both pass the count check and each
-- create a duplicate organization for the same user.
--
-- This function performs the check, the organizations insert, and the
-- organization_members insert in a single transaction, serialized per user
-- via an advisory lock, so concurrent calls for the same user_id can no
-- longer interleave. It mirrors the exact "any existing membership" check
-- the application code used, so it does not change who is allowed to onboard.
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  p_user_id        uuid,
  p_name           text,
  p_slug           text,
  p_billing_email  text,
  p_max_properties integer,
  p_trial_ends_at  timestamptz
)
 RETURNS TABLE(org_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = p_user_id) THEN
    RETURN QUERY SELECT NULL::uuid, false;
    RETURN;
  END IF;

  INSERT INTO public.organizations (name, slug, billing_email, plan, plan_status, trial_ends_at, max_properties)
  VALUES (p_name, p_slug, p_billing_email, 'starter', 'trialing', p_trial_ends_at, p_max_properties)
  RETURNING id INTO v_org_id;

  INSERT INTO public.organization_members (org_id, user_id, role, invite_accepted_at)
  VALUES (v_org_id, p_user_id, 'owner', now());

  RETURN QUERY SELECT v_org_id, true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_organization_with_owner(uuid, text, text, text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(uuid, text, text, text, integer, timestamptz) TO service_role;
