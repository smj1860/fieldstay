-- CLAUDE_58_0: Stripe Connect vendor onboarding infrastructure
--
-- vendors:
--   stripe_connect_token         — stable UUID used in onboarding email links.
--                                  Identifies the vendor without auth. Never
--                                  exposed as a real Stripe credential.
--   stripe_connect_account_id    — Stripe Express account ID (acct_...).
--                                  Stored after we create the account via API.
--   stripe_connect_charges_enabled — mirrors Stripe's charges_enabled flag.
--                                  Set to true by the Connect webhook when
--                                  the vendor completes KYC.
--   stripe_connect_onboarded_at  — timestamp when charges_enabled first became true.
--   stripe_connect_invite_sent_at— dedup guard: cron sets this once per vendor
--                                  so repeat cron runs skip already-invited vendors.
--
-- work_order_invoices:
--   One invoice per work order. Created when vendor submits their sign-off
--   with line items. Tracks payment lifecycle from pending to paid.
--
-- work_order_line_items.vendor_submitted:
--   Distinguishes PM-entered line items from vendor-submitted ones.
--   The invoice references only vendor_submitted = true items.

-- ── vendors additions ────────────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS stripe_connect_token         uuid        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id    text,
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_onboarded_at  timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_connect_invite_sent_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_stripe_connect_token
  ON vendors (stripe_connect_token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_stripe_connect_account_id
  ON vendors (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- ── work_order_line_items addition ──────────────────────────────────────────

ALTER TABLE work_order_line_items
  ADD COLUMN IF NOT EXISTS vendor_submitted boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_work_order_line_items_vendor_submitted
  ON work_order_line_items (work_order_id)
  WHERE vendor_submitted = true;

-- ── work_order_invoices ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_order_invoices (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  org_id                    uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  work_order_id             uuid        NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  vendor_id                 uuid        NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  property_id               uuid        NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  invoice_number            text        NOT NULL,
  status                    text        NOT NULL DEFAULT 'pending_payment'
    CONSTRAINT work_order_invoices_status_check
      CHECK (status IN ('pending_payment', 'paid', 'cancelled')),
  subtotal                  numeric     NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  total                     numeric     NOT NULL DEFAULT 0 CHECK (total >= 0),
  platform_fee_amount       numeric     NOT NULL DEFAULT 0 CHECK (platform_fee_amount >= 0),
  stripe_checkout_session_id text,
  stripe_payment_intent_id  text,
  paid_at                   timestamptz,
  submitted_at              timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_order_invoices_pkey PRIMARY KEY (id),
  CONSTRAINT work_order_invoices_work_order_id_key UNIQUE (work_order_id)
);

ALTER TABLE public.work_order_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "work_order_invoices_select" ON work_order_invoices;
DROP POLICY IF EXISTS "work_order_invoices_manage" ON work_order_invoices;

CREATE POLICY "work_order_invoices_select" ON work_order_invoices FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "work_order_invoices_manage" ON work_order_invoices FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

CREATE INDEX IF NOT EXISTS idx_work_order_invoices_org_id
  ON work_order_invoices (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_order_invoices_vendor_id
  ON work_order_invoices (vendor_id);

CREATE INDEX IF NOT EXISTS idx_work_order_invoices_status
  ON work_order_invoices (org_id, status)
  WHERE status != 'paid';

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_invoices_checkout_session
  ON work_order_invoices (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
