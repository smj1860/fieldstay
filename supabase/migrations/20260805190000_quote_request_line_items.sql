-- ============================================================================
-- Itemized quotes.
--
-- The RFQ flow shipped with a single scalar `quote_requests.quoted_amount`: the
-- vendor typed one number into one box. That is not what a quote is, and it
-- breaks the handoff the flow exists to make. When a quote is approved, the
-- work order is assigned to that vendor and the vendor eventually completes it
-- through the portal by entering LINE ITEMS — so the agreed scope (one lump
-- sum, no breakdown) and the invoiced scope (itemized) had no relationship to
-- each other. Nothing carried over, and nothing could be compared.
--
-- A quote now carries the same shape as the invoice it becomes:
--
--   vendor fills line items  ──►  quoted_amount = SUM(line_total), DERIVED
--          │                                        │
--          │                            PM compares vendors line by line
--          │                                        │
--          └──────────► approve ──► copied into work_order_line_items
--                                   (vendor_submitted = false — the agreed
--                                    scope, not an invoice), pre-filling the
--                                    vendor's completion form.
--
-- `line_total` is GENERATED ALWAYS, matching work_order_line_items, for the
-- same reason: a client must not be able to state a line total that disagrees
-- with its own quantity × unit cost. NAMING IT IN AN INSERT RAISES 428C9 AND
-- REJECTS THE WHOLE STATEMENT — that exact defect shipped twice in this
-- codebase (see CLAUDE.md). It is enforced by
-- unit/guardrails/generated-column-writes.test.ts, which reads
-- information_schema, not supabase/schema_reference.sql (the snapshot renders
-- generated columns as plain DEFAULTs, which is what made both inserts look
-- correct).
--
-- RLS mirrors quote_requests exactly — SELECT for any org member, writes for
-- admin/manager, service_role for the token routes. The vendor submitting a
-- quote is UNAUTHENTICATED and goes through the service role in
-- submit_quote_via_token(), never through these policies.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quote_request_line_items (
  id                uuid          NOT NULL DEFAULT gen_random_uuid(),
  quote_request_id  uuid          NOT NULL,
  org_id            uuid          NOT NULL,
  line_type         line_item_type NOT NULL DEFAULT 'material',
  description       text          NOT NULL,
  quantity          numeric(10,2) NOT NULL DEFAULT 1,
  unit              text,
  unit_cost         numeric(10,2) NOT NULL,
  line_total        numeric(10,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  sort_order        smallint      NOT NULL DEFAULT 0,
  created_at        timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT quote_request_line_items_pkey PRIMARY KEY (id),

  -- CASCADE, deliberately: a line item has no meaning without its quote, and
  -- quote_requests itself cascades from both work_orders and organizations.
  CONSTRAINT quote_request_line_items_quote_request_id_fkey
    FOREIGN KEY (quote_request_id) REFERENCES public.quote_requests(id) ON DELETE CASCADE,
  CONSTRAINT quote_request_line_items_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- A zero-cost or negative line is not a quote line. Enforced here rather
  -- than only in the route, because the route is not the only writer (the
  -- approve path reads these back and copies them into a financial record).
  CONSTRAINT quote_request_line_items_positive_cost  CHECK (unit_cost > 0),
  CONSTRAINT quote_request_line_items_positive_qty   CHECK (quantity  > 0),
  CONSTRAINT quote_request_line_items_description_nonempty CHECK (btrim(description) <> '')
);

ALTER TABLE public.quote_request_line_items ENABLE ROW LEVEL SECURITY;

-- Covering indexes on both FK columns — the db-invariants gate requires one
-- per FK column, and the quote_request_id lookup is the read path for every
-- PM-side quote comparison.
CREATE INDEX IF NOT EXISTS idx_qrli_quote_request_id
  ON public.quote_request_line_items (quote_request_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_qrli_org_id
  ON public.quote_request_line_items (org_id);

DROP POLICY IF EXISTS qrli_select       ON public.quote_request_line_items;
DROP POLICY IF EXISTS qrli_manage       ON public.quote_request_line_items;
DROP POLICY IF EXISTS qrli_service_role ON public.quote_request_line_items;

CREATE POLICY qrli_select
  ON public.quote_request_line_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY qrli_manage
  ON public.quote_request_line_items FOR ALL
  TO authenticated
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE POLICY qrli_service_role
  ON public.quote_request_line_items FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Postgres checks the GRANT before RLS ever evaluates: a table with perfect
-- policies and no grant throws "permission denied" on every query. Shipped
-- once already (20260710200000_grant_authenticated_missing_tables.sql).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_request_line_items TO authenticated;
GRANT ALL                            ON public.quote_request_line_items TO service_role;

NOTIFY pgrst, 'reload schema';
