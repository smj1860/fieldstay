-- Backfill owner_transactions.booking_id for auto-posted booking revenue.
--
-- handleBookingConfirmed (lib/inngest/functions/booking-events.ts) never set
-- booking_id, while handleBookingDetected — the sibling handler in the same
-- file, writing the same logical row — always did. That was drift, not design:
-- the column is a real FK to the booking the revenue came from, and the owners
-- page selects it.
--
-- The code fix sets it going forward. This repairs the rows already written.
--
-- Safe because source_reference_id IS the booking id for these two sources
-- (that is what makes the (source_reference_id, source) upsert idempotent per
-- booking). Verified before applying: 12 rows had a null booking_id and all 12
-- resolve to a live bookings row.
--
-- The join to bookings is what keeps this correct rather than merely
-- plausible: a source_reference_id pointing at a deleted booking is left
-- alone instead of being written into an FK that would reject it.
--
-- Deliberately NOT extended to 'booking_cancellation' (7 rows, all with a null
-- booking_id): that source's reference-id semantics were not verified here,
-- and guessing at a foreign key on a financial ledger is exactly the kind of
-- change that is hard to notice being wrong.

UPDATE owner_transactions AS t
   SET booking_id = b.id
  FROM bookings AS b
 WHERE b.id = t.source_reference_id
   AND t.source IN ('booking_revenue', 'uplisting_booking')
   AND t.booking_id IS NULL;
