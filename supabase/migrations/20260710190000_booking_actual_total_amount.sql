-- Real per-booking revenue, when the PMS reports one — distinct from the
-- nights * properties.avg_nightly_rate ESTIMATE that owner_transactions
-- revenue-posting has always relied on (see
-- lib/inngest/functions/booking-events.ts). Currently only ever populated
-- by Hospitable's reservation `financials` include (📄 spec, gated on the
-- not-yet-granted financials:read scope — see
-- docs/Integrations/hospitable/api-reference.md). Null for every other
-- source (OwnerRez, Uplisting, manual, iCal) until/unless they gain an
-- equivalent real-amount field.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS actual_total_amount numeric(10,2);

COMMENT ON COLUMN bookings.actual_total_amount IS
  'Real total booking revenue as reported by the PMS, when known — preferred
   over the nights * avg_nightly_rate estimate whenever present. Currently
   only populated by the Hospitable sync path via the (unconfirmed, pending
   financials:read scope) reservation financials include.';
