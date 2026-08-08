-- A real backstop for the platform-template broadcast's dedup.
--
-- broadcastPlatformInventoryTemplate (lib/inngest/functions/
-- platform-inventory-template-broadcast.ts) decides what to add to an org's
-- template by reading that template's existing catalog_item_ids into a Set and
-- filtering the master list against it. That read discarded its error, so a
-- read failure produced an EMPTY set, and "the org has nothing yet" is exactly
-- the input that re-inserts the entire master list.
--
-- The code fix binds the error. This is the half that does not depend on the
-- application getting it right: there was no unique index on
-- (template_id, catalog_item_id) at all, so nothing in the database could
-- refuse a duplicate — and the broadcast is deliberately re-runnable (that is
-- how new master items reach existing orgs), so every re-run rode entirely on
-- that one read succeeding. This is the "never enforced only in application
-- code" item in CLAUDE.md's Standing Audit Checklist.
--
-- Partial on catalog_item_id IS NOT NULL. Postgres already treats NULLs as
-- distinct in a UNIQUE index, so this changes nothing functionally — it states
-- the intent. All 228 rows live today have a NULL catalog_item_id: they come
-- from the pre-broadcast org seeding path, not from this function (both their
-- templates have source_platform_template_id IS NULL, so the broadcast does
-- not match them). Verified before applying: zero duplicate
-- (template_id, catalog_item_id) pairs with a non-null catalog_item_id, so
-- this index builds without a backfill.

CREATE UNIQUE INDEX IF NOT EXISTS inventory_template_items_template_catalog_unique
  ON inventory_template_items (template_id, catalog_item_id)
  WHERE catalog_item_id IS NOT NULL;
