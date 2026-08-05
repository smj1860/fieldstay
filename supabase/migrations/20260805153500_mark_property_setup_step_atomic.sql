-- Atomic merge for properties.setup_steps_completed.
--
-- markStepComplete() (app/(dashboard)/properties/actions.ts) read the jsonb
-- column, spread a new key onto it in JavaScript, and wrote the whole object
-- back. That is a read-modify-write with no precondition, and it loses
-- concurrent completions: two setup steps finishing close together — two tabs,
-- a double-submit, or two of the five caller actions overlapping — both read
-- the same object, both merge their own key, and the second write erases the
-- first. CLAUDE.md's concurrency rule names this shape exactly.
--
-- `||` on jsonb merges against the row's CURRENT value at write time, inside
-- the UPDATE, so Postgres serialises the two writers and neither can clobber
-- the other. It also removes the separate read entirely, which is what made
-- the companion bug possible (a failed read collapsed to `{}` and the merge
-- then wiped every previously completed step).
--
-- SECURITY INVOKER on purpose: properties' RLS write policy
-- (is_org_member(org_id, ARRAY['admin','manager'])) must still apply, and the
-- RETURNING is what lets the caller tell "denied / gone" (0 rows) from
-- "updated". A SECURITY DEFINER function here would silently bypass that.

DROP FUNCTION IF EXISTS public.mark_property_setup_step(uuid, uuid, text);

-- Returns the MERGED object, not just the id: the caller needs the new state
-- to decide whether the property is now fully set up, and taking it from the
-- same statement keeps that decision on the value actually written rather than
-- on a second read that could disagree.
CREATE FUNCTION public.mark_property_setup_step(
  p_property_id uuid,
  p_org_id      uuid,
  p_step        text
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  UPDATE public.properties
     SET setup_steps_completed =
           COALESCE(setup_steps_completed, '{}'::jsonb)
           || jsonb_build_object(p_step, true)
   WHERE id = p_property_id
     AND org_id = p_org_id
  RETURNING setup_steps_completed;
$$;

COMMENT ON FUNCTION public.mark_property_setup_step(uuid, uuid, text) IS
  'Atomically marks one property setup step complete. Merges into '
  'setup_steps_completed inside the UPDATE so concurrent step completions '
  'cannot overwrite each other. Returns the merged setup_steps_completed, or no '
  'row when RLS denies the write or the property does not exist.';

GRANT EXECUTE ON FUNCTION public.mark_property_setup_step(uuid, uuid, text) TO authenticated;
