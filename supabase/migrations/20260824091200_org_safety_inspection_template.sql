-- The safety inspection TEMPLATE, and the constraint that makes applying it safe.
--
-- §2 of INSPECTIONS_SPEC says inspection frequency is "set in onboarding,
-- changeable later in the Inspections tab", and neither half existed. The gap
-- was not the UI, it was that the spec talks about frequency as one org-level
-- answer while a `maintenance_schedules` row is PER PROPERTY — at 29 properties
-- that is 29 rows for one question, and the step has to fan out.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY ONLY, AND WHY THAT IS THE WHOLE DESIGN
--
-- Safety runs at every property, so it is a genuine org-level default. Indoor
-- and Outdoor are deliberately NOT here: a studio condo and a lakefront house
-- with a dock and a well do not want the same walk, and the outdoor form is
-- heavily gated on assets a condo does not have. Those are set up per property
-- as ordinary recurring maintenance, which already carries
-- `creates = 'inspection'`. Onboarding says so in one sentence and links there.
--
-- That is what keeps the step to a single question.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A MONTH, NOT A DATE — AND THIS IS NOT month_due COMING BACK
--
-- `maintenance_schedules.month_due` was dropped (20260823215150) because it
-- duplicated what `next_due_date` already said on the same row: the recurrence
-- anchor is emergent from (next_due_date, frequency), and a second column
-- naming the month could disagree with it.
--
-- A month on the TEMPLATE is a different thing. The template has no due date —
-- it is the rule that PRODUCES one, for each property, when it is applied. The
-- schedule it generates still carries a single `next_due_date` and nothing
-- else, so there is still no second source of truth about when a walk is due.
--
-- Restricted to semi_annual | annual by CHECK rather than by a narrower enum:
-- `schedule_frequency` is shared with work-order schedules, which legitimately
-- run weekly. The pair is all-or-nothing so a half-answered template cannot
-- exist — "we know how often but not when" would fan out a schedule with no
-- date, which is the dormant state and reads as a silent failure.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS inspection_safety_frequency   schedule_frequency,
  ADD COLUMN IF NOT EXISTS inspection_safety_start_month smallint;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_safety_template_complete;
-- The IS NOT NULL pair is load-bearing, not belt-and-braces. Written as just
-- `freq IN (...) AND month BETWEEN 1 AND 12`, a row with frequency = 'annual'
-- and a NULL month evaluates the second branch to UNKNOWN, and `false OR
-- UNKNOWN` is UNKNOWN — which a CHECK ACCEPTS. Postgres rejects only on FALSE.
-- So the constraint written the obvious way permitted exactly the half-answered
-- template it exists to forbid, and a canary caught it before this shipped.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_safety_template_complete CHECK (
    (inspection_safety_frequency IS NULL AND inspection_safety_start_month IS NULL)
    OR (
      inspection_safety_frequency   IS NOT NULL
      AND inspection_safety_start_month IS NOT NULL
      AND inspection_safety_frequency IN ('semi_annual', 'annual')
      AND inspection_safety_start_month BETWEEN 1 AND 12
    )
  );

COMMENT ON COLUMN organizations.inspection_safety_frequency IS
  'How often the safety walk runs at EVERY property in this org: semi_annual or annual. NULL means the onboarding step has not been answered. A template, not a schedule — it generates one maintenance_schedules row per property.';
COMMENT ON COLUMN organizations.inspection_safety_start_month IS
  'The calendar month (1-12) the safety cycle starts in. A MONTH rather than a date because a template has no due date; it is the rule that produces next_due_date for each property''s schedule.';

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE INSPECTION SCHEDULE PER (PROPERTY, FORM)
--
-- Two things apply this template — the onboarding fan-out and the nightly
-- backfill that catches properties added afterwards — and a PM can also create
-- one by hand on the Maintenance page. Three writers against a rule that says
-- "only if it doesn't already exist" is exactly the load-then-decide-then-write
-- shape that races, so the guarantee lives in the index rather than in three
-- careful callers. Both appliers can then insert with ON CONFLICT DO NOTHING
-- and stop reasoning about it.
--
-- "Twice a year" is a FREQUENCY, not two schedules, so one row per form is the
-- right cardinality and not a limitation.
--
-- Safe to add unconditionally: production holds zero rows with
-- creates = 'inspection' at the time of writing (checked, not assumed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_schedules_property_inspection_form
  ON maintenance_schedules (property_id, inspection_form_id)
  WHERE creates = 'inspection';

COMMENT ON INDEX uq_maintenance_schedules_property_inspection_form IS
  'One inspection schedule per (property, form). Makes the onboarding fan-out and the nightly backfill idempotent by construction rather than by being careful. "Twice a year" is a frequency, not two schedules.';
