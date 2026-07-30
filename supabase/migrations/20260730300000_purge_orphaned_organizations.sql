-- ============================================================================
-- Data repair: purge organizations with zero members.
--
-- app/api/account/delete/route.ts previously deleted only the auth.users row
-- and claimed it "cascades to org data via DB foreign keys". That was false —
-- there is no FK from organizations to auth.users. Only organization_members
-- .user_id and profiles.id cascade off the auth user, so the organizations row
-- and every org-scoped table under it survived: properties, bookings (carrying
-- guest_name / guest_email), owner_transactions, work_orders,
-- guidebook_guest_sms_optins, communication_logs, and the rest. With no member
-- rows left, every RLS policy (get_user_org_ids() / is_org_member()) evaluates
-- to false for every user, so the data is unreachable through the app and was
-- never going to be purged by anything.
--
-- Verified against the live project on 2026-07-30: 2 such organizations,
-- holding 10 properties and 20 bookings with guest PII.
--
-- The route is fixed in the same change (it now deletes the organizations row
-- explicitly, in a defined order, before deleting the auth user). This
-- migration cleans up the rows the old behaviour already left behind.
--
-- Deletion strategy mirrors the route exactly:
--   1. Tables carrying org_id that have NO foreign key to organizations (so
--      nothing would cascade to them) are deleted explicitly first. A sibling
--      migration is adding those FKs; this DELETE is written to be correct
--      whether or not that migration has landed, and is a harmless no-op once
--      the cascade covers them.
--   2. The organizations row itself is deleted, and the existing
--      ON DELETE CASCADE from every other org-scoped table does the real work.
--
-- Idempotent and safe to re-run: every statement is scoped to the same
-- "organizations with no members" set, which is empty after the first run.
-- ============================================================================

DO $$
DECLARE
  orphan_ids uuid[];
  tbl        text;
  n          integer;
BEGIN
  SELECT array_agg(o.id)
    INTO orphan_ids
    FROM public.organizations o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.organization_members m WHERE m.org_id = o.id
   );

  IF orphan_ids IS NULL OR cardinality(orphan_ids) = 0 THEN
    RAISE NOTICE 'purge_orphaned_organizations: no member-less organizations found; nothing to do.';
    RETURN;
  END IF;

  RAISE NOTICE 'purge_orphaned_organizations: purging % member-less organization(s): %',
    cardinality(orphan_ids), orphan_ids;

  -- Step 1 — org-scoped tables with no FK to organizations (verified against
  -- the live schema 2026-07-30). Guarded with to_regclass so this migration
  -- does not fail on an environment where one of them does not exist.
  FOREACH tbl IN ARRAY ARRAY[
    'asset_depreciation_entries',
    'assignment_outcomes',
    'vendor_assignment_outcomes',
    'crew_availability',
    'inventory_count_drafts',
    'inventory_templates',
    'maintenance_schedule_templates',
    'messages'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE org_id = ANY($1)', tbl)
        USING orphan_ids;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        RAISE NOTICE 'purge_orphaned_organizations:   %: % row(s)', tbl, n;
      END IF;
    END IF;
  END LOOP;

  -- Step 2 — the organizations rows. Everything else cascades from here.
  DELETE FROM public.organizations WHERE id = ANY(orphan_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'purge_orphaned_organizations: deleted % organization row(s).', n;
END $$;
