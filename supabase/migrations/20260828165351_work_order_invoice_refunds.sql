-- Vendor invoice refunds — Phase 1 (webhook reconciliation, no UI).
--
-- Refunds on a work_order_invoice are issued from the Stripe dashboard with
-- reverse_transfer + refund_application_fee (see lib/stripe/platform-fee.ts's
-- destination-charge comment for why both flags are load-bearing). This
-- migration adds the columns the webhook handler needs to reconcile that
-- action back into FieldStay: without it, a Stripe-side refund would leave
-- the invoice claiming 'paid', the expense sitting on the owner's P&L, and
-- work_orders.actual_cost wrong, with nothing anywhere to say otherwise.

ALTER TABLE public.work_order_invoices
  DROP CONSTRAINT IF EXISTS work_order_invoices_status_check;

ALTER TABLE public.work_order_invoices
  ADD CONSTRAINT work_order_invoices_status_check
  CHECK (status = ANY (ARRAY[
    'pending_payment'::text,
    'paid'::text,
    'cancelled'::text,
    'partially_refunded'::text,
    'refunded'::text
  ]));

-- Cents-accurate running total of what Stripe has refunded on this invoice's
-- payment intent. charge.refunded reports a CUMULATIVE amount_refunded on
-- every delivery (a second partial refund resends the running total, not a
-- delta), so the handler writes this value directly rather than incrementing
-- it — an increment would double-count on webhook retry.
ALTER TABLE public.work_order_invoices
  ADD COLUMN IF NOT EXISTS amount_refunded numeric(12,2) NOT NULL DEFAULT 0
    CHECK (amount_refunded >= 0);

ALTER TABLE public.work_order_invoices
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- Every dollar figure on this table is user (PM/vendor)-facing money data —
-- keep the same numeric(12,2) shape the rest of the table already uses,
-- checked above.

-- 'wo_invoice_refund' joins 'wo_completion' as a source value on the same
-- (source_reference_id, source) unique index (uq_owner_txn_source) that
-- already protects 'wo_completion' from double-posting. Using a DIFFERENT
-- source value — not a suffixed source_reference_id — is what keeps this
-- compensating credit from being rejected as a duplicate of the original
-- expense row: the pair (work_order_id, 'wo_completion') already exists, so
-- (work_order_id, 'wo_invoice_refund') is what the ON CONFLICT dedup needs to
-- be a distinct, idempotent row.
ALTER TABLE public.owner_transactions
  DROP CONSTRAINT IF EXISTS owner_transactions_source_check;

ALTER TABLE public.owner_transactions
  ADD CONSTRAINT owner_transactions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'wo_completion'::text,
    'booking_revenue'::text,
    'uplisting_booking'::text,
    'inventory_purchase'::text,
    'cleaning_fee'::text,
    'booking_cancellation'::text,
    'wo_invoice_refund'::text
  ]));
