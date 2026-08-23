-- Answers that are not a pass/fail.
--
-- docs/INSPECTIONS_SPEC.md §5 gives inspection_form_items five response types —
-- yes_no, count, date, text, photo — and gives inspection_items exactly one
-- place to record an answer: `result pass|fail|na`. Four of the five have
-- nowhere to land.
--
-- That is not theoretical. Three seeded items are `count`, one is `date`, nine
-- are `text`, and all of them default to is_required = true:
--
--   safety.fire.extinguisher_count       how many extinguishers
--   safety.fire.extinguisher_location    where each one is
--   safety.fire.extinguisher_expiry      the date on its tag
--   indoor.kitchen.inventory_count       counted against the inventory list
--
-- Two consequences, one worse than the other. The visible one is that the
-- Review gate requires a `result` on every required item, so it would demand a
-- pass/fail on "Number of fire extinguishers" — a question with no pass/fail to
-- give, and therefore a gate no inspector could ever satisfy.
--
-- The structural one is that extinguisher_count SIZES A REPEAT GROUP. The
-- number the inspector gives is what decides whether the form asks about three
-- extinguishers or five. With nowhere to store it, the count is lost on reload
-- and the repeat group collapses to nothing — taking every answer inside it
-- with it, silently, because the rows simply stop being rendered.
--
-- THREE COLUMNS, NOT ONE.
--
-- The tempting shortcut is to put all of it in `note`. It is wrong twice over.
-- `note` is REQUIRED on a fail and becomes the work order's title, so a text
-- answer stored there is indistinguishable from a failure description — one
-- would generate work orders titled "Kitchen, under sink". And a count parsed
-- back out of prose is the `parseInt('2.5')` class of bug this codebase has
-- already paid for once in inventory: the repeat group's SIZE would depend on
-- text parsing.
--
-- So: a real integer for counts, a real date for dates, text for text.

ALTER TABLE inspection_items
  ADD COLUMN IF NOT EXISTS value_number integer,
  ADD COLUMN IF NOT EXISTS value_text   text,
  ADD COLUMN IF NOT EXISTS value_date   date;

-- A bound, not just non-negativity. A negative count is nonsense, but the
-- typo that actually hurts is a large one: the count sizes a repeat group, so
-- "1000" renders four thousand rows and locks the tablet mid-inspection. The
-- resolver clamps as well — this is the backstop for a write that did not come
-- through it.
ALTER TABLE inspection_items
  DROP CONSTRAINT IF EXISTS inspection_items_value_number_range;
ALTER TABLE inspection_items
  ADD CONSTRAINT inspection_items_value_number_range
    CHECK (value_number IS NULL OR (value_number >= 0 AND value_number <= 999));

COMMENT ON COLUMN inspection_items.value_number IS
  'Answer for a response_type=count item. Sizes the repeat group hanging off it.';
COMMENT ON COLUMN inspection_items.value_text IS
  'Answer for a response_type=text item. NOT the same field as `note`, which is the failure description.';
COMMENT ON COLUMN inspection_items.value_date IS
  'Answer for a response_type=date item (e.g. an extinguisher tag expiry).';
