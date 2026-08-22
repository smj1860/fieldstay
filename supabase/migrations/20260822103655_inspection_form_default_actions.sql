-- Inspections — the `Dflt` column every one of the ~137 spec rows carries had
-- nowhere to land.
--
-- Phase 1 gave inspection_form_items a `remediation` column
-- (none|work_order|purchase_order|notify) and hung the spec's "PRE-SELECTED
-- action, not a constraint" comment on it. Writing the seed is what showed the
-- two are different questions and neither derives from the other:
--
--   remediation      — what KIND of record this item can produce at all.
--                      'notify' and 'none' mean it never dispatches anyone.
--   default_actions  — which action chips are pre-ticked when it FAILS.
--
-- §12.1 item 8 (dryer vent, Service) and item 10 (exit doors, Repair) are both
-- remediation = 'work_order'. Repair and Service both generate a work order, so
-- `remediation` cannot tell them apart — and getting the pre-tick wrong costs
-- the exact "one tap" the seed exists to buy. The reverse derivation fails too:
-- §5 made actions MULTI-SELECT precisely so a water heater at end of life can
-- default to Replace AND Service — the purchase and the install — which a single
-- enum cannot express in either direction.
--
-- ARRAY, not a scalar, for that reason. Empty is meaningful and is the correct
-- value for every 'notify' and 'none' item: those have no action to pre-tick.

ALTER TABLE public.inspection_form_items
  ADD COLUMN IF NOT EXISTS default_actions inspection_action[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.inspection_form_items.default_actions IS
  'Pre-ticked action chips on a FAIL. Not a constraint — the inspector adds or '
  'removes freely, and inspection_items.actions records what they actually '
  'chose. Empty for notify/none items, which never dispatch.';

-- The coherence rule between the two columns, enforced here rather than left to
-- the seed test alone: the test reads the REPO definitions, so it cannot see a
-- row written by any other path (a hand-fixed typo through the dashboard, a
-- future admin surface). An item that says "never dispatch" while pre-ticking
-- an action that dispatches is contradictory whatever wrote it.
--
-- NOT VALID is deliberate and does nothing here — the table is empty at this
-- point, so it validates instantly either way — but stating the intent: this
-- constrains what may be WRITTEN from now on.
ALTER TABLE public.inspection_form_items
  DROP CONSTRAINT IF EXISTS inspection_form_items_actions_match_remediation;

ALTER TABLE public.inspection_form_items
  ADD CONSTRAINT inspection_form_items_actions_match_remediation
  CHECK (
    remediation NOT IN ('none', 'notify')
    OR cardinality(default_actions) = 0
  );
