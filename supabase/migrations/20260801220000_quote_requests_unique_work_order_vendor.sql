-- ============================================================================
-- One RFQ per vendor per work order.
--
-- quote_requests had UNIQUE only on quote_token (which is per-row by
-- construction, so it constrains nothing about duplicates). Nothing stopped the
-- same vendor being RFQ'd twice for the same work order: a double-clicked
-- "Request quotes" button, or a retried submission, sent that vendor two
-- separate emails carrying two separate live quote tokens. Both remain
-- valid, both can be submitted, and approving one leaves the other open
-- against a work order that already has a vendor.
--
-- A partial index, not a plain UNIQUE: a cancelled or declined RFQ should not
-- block legitimately re-requesting a quote from the same vendor later. Only
-- rows in a still-live state are constrained.
--
-- Verified before applying: ZERO duplicate (work_order_id, vendor_id) pairs
-- exist on either project today (production has 0 quote_requests rows at all),
-- so this creates cleanly rather than failing on existing data.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS quote_requests_work_order_vendor_live_uniq
  ON public.quote_requests (work_order_id, vendor_id)
  WHERE status IN ('pending', 'submitted');

NOTIFY pgrst, 'reload schema';
