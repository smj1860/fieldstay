-- ============================================================================
-- Inventory counts accept fractional quantities (2 decimal places).
--
-- WHY
--
-- Real inventory is not always whole: half a case of paper towels, 1.5 gallons
-- of cleaner, a third of a bulk bag. The count fields were `integer`, so a
-- crew member standing at the property could only round — and rounding a count
-- is not a display nicety, it feeds par comparison, the below-par trigger and
-- the purchase-order quantities built from it.
--
-- WHAT WAS ALREADY DECIMAL, AND WHAT WAS NOT
--
-- The par side was ALREADY `numeric`: inventory_items.par_level,
-- inventory_template_items.par_level, inventory_catalog.default_par_level and
-- org_inventory_catalog.default_par_level. The UI even offers step=0.5 on par
-- inputs. Only the COUNT side was integer, so the schema could express
-- "par 2.5" but not "I counted 2.5" — the halves were representable as a
-- target and not as an observation.
--
-- THE RPC IS THE PART THAT WOULD HAVE MADE A COLUMN-ONLY CHANGE FAIL
--
-- apply_inventory_counts() reads the submitted counts with
--
--     jsonb_to_recordset(p_counts) AS c(item_id uuid, qty integer)
--
-- That `integer` is a cast at the boundary, not a consequence of the column
-- type. Retyping the columns and stopping there would leave every crew
-- submission of 2.5 failing with 22P02 inside the RPC — and because
-- lib/dexie/net.ts treats >=500 as transient, that submission would retry
-- forever as a poison pill. The function is recreated below with `qty numeric`.
--
-- purchase_order_items is included because its three quantity columns are
-- derived from these: quantity_to_buy is computed as par_level - counted in
-- lib/inngest/functions/inventory-events.ts, and current_quantity/par_level are
-- snapshots taken at PO creation. Leaving them integer would move the same
-- failure one step downstream, into cart building, where it is much less
-- obvious.
--
-- PRECISION: numeric(12,2). Two decimal places is what the request asked for
-- as the preferred granularity. Verified against production before choosing
-- it: 1581 inventory items, zero par levels carrying more than 2 dp, max
-- quantity 20 and max par 124 — so 12 digits of precision is far beyond any
-- real value and the scale loses nothing that exists today.
--
-- par_level is deliberately NOT re-typed. It is already unconstrained
-- `numeric` and already accepts decimals; constraining it to (12,2) would be a
-- silent rounding of existing rows for no functional gain.
--
-- Idempotent: each ALTER is guarded on the live column type, so a re-run is a
-- no-op rather than a needless table rewrite.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'inventory_items'
       AND column_name = 'current_quantity' AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.inventory_items
      ALTER COLUMN current_quantity TYPE numeric(12,2)
      USING current_quantity::numeric(12,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'inventory_count_items'
       AND column_name = 'quantity_counted' AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.inventory_count_items
      ALTER COLUMN quantity_counted TYPE numeric(12,2)
      USING quantity_counted::numeric(12,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'purchase_order_items'
       AND column_name = 'quantity_to_buy' AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.purchase_order_items
      ALTER COLUMN current_quantity TYPE numeric(12,2) USING current_quantity::numeric(12,2),
      ALTER COLUMN par_level        TYPE numeric(12,2) USING par_level::numeric(12,2),
      ALTER COLUMN quantity_to_buy  TYPE numeric(12,2) USING quantity_to_buy::numeric(12,2);
  END IF;
END $$;

-- The boundary cast. `qty numeric` rather than `qty integer` — see header.
-- Recreated verbatim otherwise: SECURITY DEFINER, the pinned search_path, and
-- the org-membership check that is the reason this RPC takes p_org_id at all
-- (the item ids come from the client).
CREATE OR REPLACE FUNCTION public.apply_inventory_counts(p_org_id uuid, p_counts jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_applied integer := 0;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;
  UPDATE public.inventory_items i
     SET current_quantity = c.qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at = now()
    FROM jsonb_to_recordset(p_counts) AS c(item_id uuid, qty numeric)
   WHERE i.id = c.item_id AND i.org_id = p_org_id;
  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END; $function$;
