-- Leg 1 of auto-applying a standard inventory template: mark WHICH platform
-- template is the standard.
--
-- Today the only way a platform template reaches an org is a platform admin
-- pressing Broadcast and picking one by hand. For the template to be applied
-- automatically at org signup and at property creation (legs 2 and 3), the
-- system has to be able to answer "which one is the standard?" without a human
-- in the loop. That is what is_default is for.
--
-- The partial unique index is the real enforcement: at most ONE row may carry
-- is_default = true, and Postgres refuses the second one rather than leaving
-- the app to pick a winner. Zero defaults is a valid state (nothing is applied
-- automatically), so the index is partial rather than a plain UNIQUE.

ALTER TABLE public.platform_inventory_templates
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS platform_inventory_templates_one_default
  ON public.platform_inventory_templates (is_default)
  WHERE is_default;

-- ── Why this is an RPC and not an UPDATE at the call site ──────────────────
-- The obvious single statement,
--
--   UPDATE platform_inventory_templates
--   SET is_default = (id = p_template_id)
--   WHERE is_default OR id = p_template_id;
--
-- is WRONG, and wrong in the worst way: it depends on physical scan order.
-- Postgres checks a unique index per row as each new row version is written,
-- not at statement end, and a partial unique index cannot be declared
-- DEFERRABLE (Postgres has no partial unique CONSTRAINT, only a partial unique
-- INDEX). So if the scan reaches the row being SET before the row being
-- CLEARED, two rows momentarily carry is_default = true and the statement
-- aborts with 23505.
--
-- Verified empirically rather than reasoned about, on a throwaway table:
-- flipping to a HIGHER id than the current default succeeded, flipping to a
-- LOWER id raised unique_violation and rolled back with nothing changed. That
-- is a bug that passes every test written against a fresh fixture and then
-- fails for about half of real inputs.
--
-- Clearing first in a separate statement removes the overlap entirely: by the
-- time the second statement runs, the first has fully landed in the index. The
-- function body is one implicit transaction, so the pair is still atomic and
-- no window exists where zero templates are default.
--
-- SECURITY INVOKER (the default): the caller's own RLS applies, and
-- platform_inventory_templates is already gated FOR ALL USING
-- (is_platform_staff_admin()). Making this DEFINER would hand every
-- authenticated user the ability to repoint the standard template.
CREATE OR REPLACE FUNCTION public.set_default_platform_inventory_template(p_template_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.platform_inventory_templates
     SET is_default = false
   WHERE is_default AND id <> p_template_id;

  UPDATE public.platform_inventory_templates
     SET is_default = true
   WHERE id = p_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform inventory template % not found or not visible', p_template_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.set_default_platform_inventory_template(uuid) IS
  'Repoints the standard platform inventory template. Two statements on '
  'purpose: a single UPDATE flipping both rows can transiently violate '
  'platform_inventory_templates_one_default depending on scan order.';

GRANT EXECUTE ON FUNCTION public.set_default_platform_inventory_template(uuid) TO authenticated;
