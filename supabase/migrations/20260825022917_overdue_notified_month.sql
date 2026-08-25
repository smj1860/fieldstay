-- The overdue email becomes a MONTHLY digest, so its dedupe key changes meaning.
--
-- 20260825014535 added `overdue_notified_for date`, holding the due date already
-- mailed about — a once-per-OCCURRENCE key. The cadence is now once per MONTH,
-- on the 1st, listing everything still outstanding, so the key has to be the
-- month we last wrote about a schedule rather than the occurrence.
--
-- WHY THE CADENCE CHANGED, since the column comment is where the next reader
-- will look for it:
--
-- Inspection due dates cluster by MONTH, not by day. applySafetyTemplate seeds
-- every property with the 1st of the template's month, and from the second
-- occurrence onward nudgeDueDateIntoVacancy moves each one to a different day
-- inside roughly that month, chosen from that property's own booking gaps. A
-- "three days after the due date" rule therefore produces a trickle of emails
-- across the month — one per distinct gap — which is the aggregation problem in
-- a slower form. One email on the 1st covering the month just ended replaces
-- the trickle with a digest.
--
-- RENAMED RATHER THAN REPURPOSED. A `_for` column holding a month instead of a
-- due date would be read as a due date by the next person to touch it, and the
-- bug that produces — comparing a month against a due date — has no visible
-- symptom until an email silently stops arriving. Free to rename: the column
-- shipped hours ago and holds 0 non-null values in production.

ALTER TABLE maintenance_schedules
  RENAME COLUMN overdue_notified_for TO overdue_notified_month;

COMMENT ON COLUMN maintenance_schedules.overdue_notified_month IS
  'First-of-month of the digest that last reported this schedule as overdue. NULL = never reported. A schedule that stays overdue is reported again next month, because the month changes — that recurrence is deliberate, and it is the whole reason this holds a month rather than the occurrence''s due date.';
