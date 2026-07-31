-- Pre-launch audit 2026-07-30 — deliberate ON DELETE behaviour for FKs whose
-- current action destroys financial/audit records, plus the one crew FK that
-- was left at the implicit default.
--
-- ── Why NO ACTION and not RESTRICT ────────────────────────────────────────
-- The intent for the ledger FKs is "deleting a property must not erase its
-- P&L". RESTRICT would express that, and work_order_invoices.property_id
-- already uses it — but RESTRICT is checked IMMEDIATELY and cannot be
-- deferred, so it also aborts a legitimate `DELETE FROM organizations`, whose
-- cascade removes the referencing rows (org_id → ON DELETE CASCADE) and the
-- referenced properties in the SAME statement, in an unspecified order. That
-- is precisely the statement the account-deletion fix (blocker B3) is being
-- built around. NO ACTION expresses the same guarantee for a direct property
-- delete while deferring the check to end of statement, so an org-level
-- cascade that removes both sides resolves cleanly and deterministically.
--
-- Property removal in the product is a soft delete anyway
-- (app/(dashboard)/properties/actions.ts:534,670 set is_active = false);
-- there is no hard-delete path in app/ or lib/, so these constraints only
-- ever fire for direct SQL/dashboard deletion, which is exactly when the
-- ledger must be protected.

-- owner_transactions.property_id — the owner-facing P&L ledger. CASCADE means
-- one property delete silently erases every revenue/expense row a property
-- owner has ever been shown.
ALTER TABLE public.owner_transactions
  DROP CONSTRAINT IF EXISTS owner_transactions_property_id_fkey;
ALTER TABLE public.owner_transactions
  ADD  CONSTRAINT owner_transactions_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE NO ACTION;

-- purchase_orders.property_id — restock spend, feeds the same ledger.
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_property_id_fkey;
ALTER TABLE public.purchase_orders
  ADD  CONSTRAINT purchase_orders_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE NO ACTION;

-- work_order_invoices.property_id / .vendor_id were RESTRICT — same intent,
-- but they would abort an org cascade nondeterministically (see above).
-- Realigned to NO ACTION so all four money-bearing FKs behave identically.
ALTER TABLE public.work_order_invoices
  DROP CONSTRAINT IF EXISTS work_order_invoices_property_id_fkey;
ALTER TABLE public.work_order_invoices
  ADD  CONSTRAINT work_order_invoices_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE NO ACTION;

ALTER TABLE public.work_order_invoices
  DROP CONSTRAINT IF EXISTS work_order_invoices_vendor_id_fkey;
ALTER TABLE public.work_order_invoices
  ADD  CONSTRAINT work_order_invoices_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE NO ACTION;

-- work_order_invoices.work_order_id was CASCADE: deleting a work order
-- deleted its PAID invoices with it. work_order_id is NOT NULL, so SET NULL
-- is not available — NO ACTION keeps the invoice and blocks the WO delete
-- until the invoice is dealt with, which is the correct direction for a
-- financial record.
ALTER TABLE public.work_order_invoices
  DROP CONSTRAINT IF EXISTS work_order_invoices_work_order_id_fkey;
ALTER TABLE public.work_order_invoices
  ADD  CONSTRAINT work_order_invoices_work_order_id_fkey
  FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id) ON DELETE NO ACTION;

-- work_orders.reported_by_crew_member_id was the implicit NO ACTION default
-- while every other crew FK (assigned_crew_member_id, the deprecated
-- assigned_crew_id) is SET NULL. Deleting a crew member currently fails
-- outright if they ever flagged a work order. The column is nullable, so
-- align it with its siblings.
ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_reported_by_crew_member_id_fkey;
ALTER TABLE public.work_orders
  ADD  CONSTRAINT work_orders_reported_by_crew_member_id_fkey
  FOREIGN KEY (reported_by_crew_member_id) REFERENCES public.crew_members(id) ON DELETE SET NULL;

-- ── Dangling references with no FK at all ─────────────────────────────────
-- All three columns are nullable and hold zero orphan rows today (verified
-- 2026-07-30 against vpmznjktllhmmbfnxuvk), so SET NULL is both available and
-- the right semantic: losing the provenance pointer must not delete the
-- record that was produced from it.

ALTER TABLE public.maintenance_completions
  DROP CONSTRAINT IF EXISTS maintenance_completions_work_order_id_fkey;
ALTER TABLE public.maintenance_completions
  ADD  CONSTRAINT maintenance_completions_work_order_id_fkey
  FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id) ON DELETE SET NULL;

ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_source_schedule_id_fkey;
ALTER TABLE public.work_orders
  ADD  CONSTRAINT work_orders_source_schedule_id_fkey
  FOREIGN KEY (source_schedule_id) REFERENCES public.maintenance_schedules(id) ON DELETE SET NULL;

ALTER TABLE public.maintenance_schedules
  DROP CONSTRAINT IF EXISTS maintenance_schedules_source_catalog_item_id_fkey;
ALTER TABLE public.maintenance_schedules
  ADD  CONSTRAINT maintenance_schedules_source_catalog_item_id_fkey
  FOREIGN KEY (source_catalog_item_id) REFERENCES public.org_maintenance_catalog_items(id) ON DELETE SET NULL;

-- messages.sender_id / recipient_id reference auth.users but had no FK, so a
-- deleted account left unreachable message rows behind (the same orphaning
-- class as blocker B3). SET NULL is NOT possible: both columns are NOT NULL
-- and the RLS policies compare them directly to auth.uid()
-- (20260617060719_fix_auth_rls_initplan.sql:140-158) — making them nullable
-- would change those predicates' meaning and break every consumer that reads
-- m.sender_id. CASCADE is the correct remaining option: a message with no
-- surviving counterpart is undeliverable and unreadable, and deleting it is
-- what account erasure is supposed to do.
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.messages
  ADD  CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_recipient_id_fkey;
ALTER TABLE public.messages
  ADD  CONSTRAINT messages_recipient_id_fkey
  FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Every FK column needs a covering index (db-invariants check 3). The three
-- columns that previously had no constraint may also have no index.
CREATE INDEX IF NOT EXISTS idx_maintenance_completions_work_order_id
  ON public.maintenance_completions (work_order_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_source_schedule_id
  ON public.work_orders (source_schedule_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_source_catalog_item_id
  ON public.maintenance_schedules (source_catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id
  ON public.messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_id
  ON public.messages (recipient_id);
