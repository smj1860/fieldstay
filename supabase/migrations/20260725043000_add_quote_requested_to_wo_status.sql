-- wo_status.quote_requested exists on the production project but was never
-- captured in a tracked migration (added out-of-band at some point after
-- the original 20260524165615_fieldstay_v1_extensions_enums.sql, which only
-- defines pending/assigned/in_progress/completed/cancelled). The E2E project
-- (created fresh from migrations alone) never got it, so every query
-- filtering work_orders.status with 'quote_requested' in the list — e.g.
-- app/(dashboard)/maintenance/page.tsx's board query — throws "invalid
-- input value for enum wo_status" there, silently (the query's `error` is
-- never checked), making every work order vanish from the board.
ALTER TYPE wo_status ADD VALUE IF NOT EXISTS 'quote_requested' AFTER 'pending';
