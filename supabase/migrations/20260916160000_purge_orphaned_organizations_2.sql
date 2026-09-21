-- ============================================================================
-- Data repair: purge organizations with zero members (second pass).
--
-- Same defect and same fix as 20260730300000_purge_orphaned_organizations.sql
-- (see that file for the full history) — this is not a recurrence of the
-- account-deletion bug that migration closed; the 5 orgs found here on
-- 2026-09-16 all predate that 2026-07-30 fix (created 2026-06-12 through
-- 2026-07-26: "Testing OwnerRez", "OwnerRez Testing", two "FieldStay Testing",
-- and "E2E" — QA/test artifacts, not customer deletions that slipped through
-- the fixed path) and simply were not swept up by the first pass, whose
-- WHERE clause only ever mattered against the org set live at the time it
-- ran. db_invariant_report()'s orgs_without_members check has no allowlist
-- (scripts/check-db-invariants.mjs check 7) — any non-empty result is a
-- hard CI failure, and re-running this pattern is how it clears.
--
-- Table list matches ORG_TABLES_BLOCKING_CASCADE + ORG_TABLES_WITHOUT_CASCADE
-- in lib/inngest/functions/account-deletion.ts as of 2026-09-16 (re-verified
-- against the live FK graph that day), NOT the 2026-07-30 migration's list —
-- that list was missing owner_transactions and purchase_orders, both of which
-- carry the same ON DELETE NO ACTION edge into properties that
-- work_order_invoices does, and inventory_count_drafts, which no longer
-- exists (dropped by 20260804125424_drop_inventory_count_drafts.sql; the
-- to_regclass guard below makes referencing it harmless either way).
--
-- Idempotent and safe to re-run: every statement is scoped to whatever the
-- "organizations with no members" set is AT RUN TIME, which is empty after
-- a run that already covered the live orphans.
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
    RAISE NOTICE 'purge_orphaned_organizations_2: no member-less organizations found; nothing to do.';
    RETURN;
  END IF;

  RAISE NOTICE 'purge_orphaned_organizations_2: purging % member-less organization(s): %',
    cardinality(orphan_ids), orphan_ids;

  -- Step 1 — ordered explicit deletes for tables the cascade cannot be
  -- trusted to reach in a safe order (ORG_TABLES_BLOCKING_CASCADE) or that
  -- have no FK to organizations at all (ORG_TABLES_WITHOUT_CASCADE). Order
  -- within the first four matters: work_order_invoices before work_orders
  -- (its own NO ACTION edge into work_orders). Guarded with to_regclass so
  -- this is a harmless no-op against any environment missing a table.
  FOREACH tbl IN ARRAY ARRAY[
    -- ORG_TABLES_BLOCKING_CASCADE
    'work_order_invoices',
    'owner_transactions',
    'purchase_orders',
    'work_orders',
    -- ORG_TABLES_WITHOUT_CASCADE
    'asset_depreciation_entries',
    'assignment_outcomes',
    'vendor_assignment_outcomes',
    'crew_availability',
    'inventory_templates',
    'maintenance_schedule_templates',
    'messages'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE org_id = ANY($1)', tbl)
        USING orphan_ids;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        RAISE NOTICE 'purge_orphaned_organizations_2:   %: % row(s)', tbl, n;
      END IF;
    END IF;
  END LOOP;

  -- Step 2 — the organizations rows. Everything else cascades from here.
  DELETE FROM public.organizations WHERE id = ANY(orphan_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'purge_orphaned_organizations_2: deleted % organization row(s).', n;
END $$;
