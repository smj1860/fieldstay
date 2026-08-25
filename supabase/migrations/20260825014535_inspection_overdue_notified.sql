-- Per-occurrence dedupe for the overdue-inspection email.
--
-- The email fires once per OCCURRENCE, not once per schedule and not daily. The
-- occurrence is identified by the date it was due, so remembering which date we
-- have already mailed about is the whole mechanism.
--
-- A date rather than a boolean or a timestamp. A boolean could never be reset
-- for the next occurrence without a second write, and a bare "sent_at"
-- timestamp cannot answer "sent about WHICH due date" — the question that
-- matters, because next_due_date advances on completion and the same schedule
-- comes due again next year.
--
-- The comparison is `overdue_notified_for IS DISTINCT FROM next_due_date`, not
-- `<`. An inspection completed late advances next_due_date FORWARD, but the
-- vacancy nudge (lib/maintenance/vacant-due-date.ts) can also move a future due
-- date EARLIER to land it in a gap between bookings. A `<` comparison would
-- treat that as already-notified and swallow the next email.

ALTER TABLE maintenance_schedules
  ADD COLUMN IF NOT EXISTS overdue_notified_for date;

COMMENT ON COLUMN maintenance_schedules.overdue_notified_for IS
  'The next_due_date this schedule has already produced an overdue email for. NULL = never. Compared with IS DISTINCT FROM, not <, because the vacancy nudge can move a due date earlier as well as later.';

-- Partial: the overwhelming majority of schedules have never been overdue, and
-- the cron only ever asks about rows that have a due date in the past.
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_overdue_inspection
  ON maintenance_schedules (next_due_date)
  WHERE creates = 'inspection' AND is_active;
