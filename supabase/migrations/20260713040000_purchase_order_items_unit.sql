-- The unit value is already computed upstream in inventory-events.ts (used
-- directly in the same-day-flip immediate email) but was never persisted
-- on the purchase order line item itself, so the daily aggregated restock
-- email has no way to show it. Nullable, no default — existing rows won't
-- have one; the email code handles a missing unit gracefully.
ALTER TABLE purchase_order_items
  ADD COLUMN unit text;
