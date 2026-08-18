-- 20260818012532_upsert_rpcs_for_partial_expression_indexes.sql
-- ============================================================================
-- Two upserts in the app name arbiter indexes that PostgREST cannot express,
-- so both throw 42P10 on EVERY call. Verified against production 2026-08-18 by
-- planning each statement (EXPLAIN resolves the arbiter, so it fails without
-- writing anything):
--
--   INSERT INTO vendors ... ON CONFLICT (org_id, email)
--     -> 42P10. The only matching index is
--        vendors_org_id_lower_email_key ON (org_id, lower(email))
--        WHERE (email IS NOT NULL) — an EXPRESSION index AND a PARTIAL one.
--
--   INSERT INTO checklist_templates ... ON CONFLICT (property_id, org_id)
--     -> 42P10. There is no unique index on that pair at all; the only one is
--        uniq_checklist_templates_one_default_per_property ON (property_id)
--        WHERE is_default.
--
-- Supabase JS's `onConflict` takes a bare COLUMN LIST. A partial index can only
-- be inferred when the statement repeats the index predicate, and an expression
-- index can never be named by column names at all — so neither is reachable
-- from the client, at any spelling. Moving the write into SQL is the fix, not a
-- workaround: this is the only place the predicate can be written.
--
-- Deliberately NOT "add a plain unique index to match the code":
--   * vendors — lower(email) is intentional case-insensitivity, and the partial
--     predicate is what lets many vendors have a NULL email. A plain
--     (org_id, email) unique would make Vendor A <vendor@x.com> and
--     Vendor A <Vendor@X.com> two different vendors again, which is the
--     duplicate this index exists to prevent.
--   * checklist_templates — a property is MEANT to have several named templates
--     with one default. A unique on (property_id, org_id) would cap it at one
--     template per property and break the feature.
--
-- SECURITY INVOKER (the default) on both, on purpose: the callers are a Server
-- Action on an RLS-enforced client and an Inngest step on the service role, and
-- invoker semantics keep RLS applying to the former exactly as it does today. A
-- SECURITY DEFINER here would silently hand the Server Action an RLS bypass it
-- does not have now. Both still filter on org_id explicitly regardless — see
-- CLAUDE.md's tenant-isolation rule.
-- ============================================================================

-- ── vendors ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_vendor_by_email(
  p_org_id uuid,
  p_name   text,
  p_email  text
)
RETURNS TABLE (id uuid, name text, email text, phone text)
LANGUAGE plpgsql
AS $$
-- RETURNS TABLE declares OUT parameters named id/name/email/phone, which
-- SHADOW the columns of the same name inside the body — so `lower(email)` and
-- `email IS NOT NULL` below are ambiguous and the function raises 42702 on
-- every call. (The identical statement planned fine as raw SQL; the collision
-- exists only inside plpgsql, which is why this was caught by executing the
-- function rather than by EXPLAINing the statement.) `use_column` resolves
-- bare identifiers to the column, which is correct everywhere here — every
-- parameter is p_-prefixed and cannot collide.
#variable_conflict use_column
BEGIN
  -- A NULL/blank email cannot collide on a partial index predicated on
  -- `email IS NOT NULL`, so it would insert an unbounded number of duplicate
  -- rows. The caller already requires an address; reject rather than silently
  -- create one more vendor per click.
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'upsert_vendor_by_email requires an email address'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  RETURN QUERY
  INSERT INTO public.vendors (org_id, name, email, is_active)
  VALUES (p_org_id, p_name, btrim(p_email), true)
  -- Repeating the index predicate is what makes the partial index inferable.
  ON CONFLICT (org_id, lower(email)) WHERE email IS NOT NULL
  -- A no-op touch rather than overwriting `name`: reaching this branch means a
  -- concurrent request already created the vendor, and the caller's job here is
  -- to GET the row, not to rename a vendor the org may have curated. Plain
  -- DO NOTHING would return no row at all, which is why this is an UPDATE.
  DO UPDATE SET updated_at = now()
  RETURNING vendors.id, vendors.name, vendors.email, vendors.phone;
END;
$$;

COMMENT ON FUNCTION public.upsert_vendor_by_email(uuid, text, text) IS
  'Insert-or-fetch a vendor keyed on (org_id, lower(email)). Exists because '
  'that unique index is both an expression index and a partial one, so '
  'PostgREST''s column-list onConflict cannot name it and every such upsert '
  'threw 42P10.';

GRANT EXECUTE ON FUNCTION public.upsert_vendor_by_email(uuid, text, text) TO authenticated;

-- ── checklist_templates ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_default_checklist_template(
  p_org_id      uuid,
  p_property_id uuid,
  p_name        text
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.checklist_templates (property_id, org_id, name, is_default)
  VALUES (p_property_id, p_org_id, p_name, true)
  -- The real invariant: ONE default template per property. Repeating
  -- `WHERE is_default` is what makes that partial index inferable.
  ON CONFLICT (property_id) WHERE is_default
  DO UPDATE SET name = excluded.name, updated_at = now()
  -- Tenant guard. The arbiter cannot include org_id (the index is on
  -- property_id alone), so the org check lives here. A mismatch updates
  -- nothing and RETURNING yields no row, which surfaces below as an
  -- exception rather than as a silent no-op.
  WHERE checklist_templates.org_id = p_org_id
  RETURNING checklist_templates.id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'checklist template for property % is not in org %', p_property_id, p_org_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_default_checklist_template(uuid, uuid, text) IS
  'Insert-or-update the ONE default checklist template for a property. Exists '
  'because the invariant is enforced by a PARTIAL unique index '
  '(property_id) WHERE is_default, which PostgREST''s column-list onConflict '
  'cannot name; the broadcast''s upsert threw 42P10 on every target property.';

GRANT EXECUTE ON FUNCTION public.upsert_default_checklist_template(uuid, uuid, text) TO authenticated;
