-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- Adds two columns that application code already references but that do not
-- exist in the current schema, causing silent failures in template operations.

ALTER TABLE public.inventory_template_items
  ADD COLUMN IF NOT EXISTS notes           text,
  ADD COLUMN IF NOT EXISTS catalog_item_id uuid
    REFERENCES public.inventory_catalog(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inventory_template_items.notes IS
  'Optional notes shown to crew when item appears in a turnover checklist.';

COMMENT ON COLUMN public.inventory_template_items.catalog_item_id IS
  'Reference back to inventory_catalog for deduplication when applying
   a template to a property that already has the same item.';
