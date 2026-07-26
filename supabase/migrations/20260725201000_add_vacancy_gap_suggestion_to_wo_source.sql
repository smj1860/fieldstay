-- First-run reconciliation finding from the types/database.ts drift gate
-- (scripts/check-type-drift.mjs): WoSource in types/database.ts declares
-- 'vacancy_gap_suggestion' — and app/(dashboard)/maintenance/actions.ts's
-- advanceScheduleAfterCompletion() branches on it — but the wo_source enum
-- on BOTH projects lacks the label, so any future write of that source
-- value would throw "invalid input value for enum wo_source" at runtime.
-- Same failure class as the wo_status.quote_requested incident
-- (20260725043000_add_quote_requested_to_wo_status.sql), caught before it
-- shipped this time. Align the DB with the compile-time type.
ALTER TYPE wo_source ADD VALUE IF NOT EXISTS 'vacancy_gap_suggestion';
