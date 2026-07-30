-- Enforce organizations.max_properties in the database.
--
-- The application check in app/(dashboard)/properties/actions.ts was
-- count-then-insert with nothing between the two: two creations submitted at
-- the same moment on an org sitting at its limit both read the pre-insert
-- count and both passed. It also failed OPEN — the count's error was
-- discarded and `count ?? 0` coerced a failed count to zero, which disables
-- the plan limit entirely for that request.
--
-- Neither is fixable in application code alone, and properties are created
-- from more than one path (the create form, the clone action, the setup
-- wizard, PMS sync), so the limit belongs where every path meets it. The
-- application check stays, but only as UX — this is the enforcement boundary.
--
-- The FOR UPDATE row lock on organizations is what actually closes the race:
-- concurrent inserts for the same org serialize behind it, so the second one
-- counts the first one's row.

CREATE OR REPLACE FUNCTION public.enforce_property_plan_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max   integer;
  v_count integer;
BEGIN
  -- Only active properties consume plan capacity, so only an insert that
  -- lands active (or a reactivation) needs checking.
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.is_active IS TRUE AND OLD.org_id = NEW.org_id THEN
    RETURN NEW;   -- already counted; an ordinary edit must not be blocked
  END IF;

  SELECT max_properties INTO v_max
  FROM public.organizations
  WHERE id = NEW.org_id
  FOR UPDATE;   -- serializes concurrent creations for this org

  IF v_max IS NULL THEN
    RAISE EXCEPTION 'Organization % not found' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.properties
  WHERE org_id = NEW.org_id
    AND is_active = true
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_count >= v_max THEN
    -- 'check_violation' so the app layer can recognize this specific refusal
    -- (Postgres code 23514) and show the upgrade prompt rather than a generic
    -- "operation failed".
    RAISE EXCEPTION
      'Property limit reached: this plan allows up to % active properties.', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_property_plan_limit_trigger ON public.properties;

CREATE TRIGGER enforce_property_plan_limit_trigger
  BEFORE INSERT OR UPDATE OF is_active, org_id ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_property_plan_limit();
