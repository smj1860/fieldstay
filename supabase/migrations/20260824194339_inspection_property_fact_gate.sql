-- Security-system questions on the Safety form, and the "ask once" gate they need.
--
-- Requested behaviour: ask every property whether it has a monitored alarm on
-- the FIRST inspection, and once answered stop asking. Two new capabilities,
-- because the existing gates cannot express it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NOT THE ASSET LEDGER, WHICH IS THE EXISTING GATE
--
-- `inspection_form_sections.shown_when_asset` hides a section unless the
-- property has an ACTIVE `property_assets` row of that type. That is the right
-- shape for a hot tub or a well pump, and it is the wrong shape here for two
-- reasons.
--
-- It cannot record an absence. "This property has no alarm system" is the
-- answer for most properties and is the thing we must remember in order to stop
-- asking, and the ledger has no row for a thing that does not exist. An
-- is_active = false row would be a lie of a different kind — that is the
-- representation for an asset that WAS there and was replaced.
--
-- And it never asks the first time. Asset-gating is downstream of somebody
-- having catalogued the asset; the whole point of this item is to capture the
-- fact from the inspector rather than depend on that.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A PROPERTY COLUMN AND NOT AN ANSWER-HISTORY LOOKUP
--
-- "Has this item been answered before at this property?" is the literal reading
-- of the request, and it is not computable where the decision has to be made.
-- The form is resolved ON THE DEVICE (`resolveFormPages` in fill-screen.tsx),
-- from the snapshot plus the property's cached assets, and the snapshot itself
-- is built on the device — `lib/dexie/dashboard/start-inspection-local.ts` — so
-- a walk can begin with no connection. Gating on inspection history would mean
-- caching a property's whole answer history to decide whether to render one
-- row.
--
-- `properties` is already cached on the device. A nullable boolean there is
-- offline-computable, survives a re-seed, and — unlike an answer buried in a
-- past inspection — is correctable by the PM when an alarm is installed later,
-- which is the one hole a fact captured once inevitably has.
--
-- NULL means "never asked", which is why the column is nullable rather than
-- NOT NULL DEFAULT false. A default of false would silently answer the question
-- for every existing property and the capture item would never render.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS has_security_system boolean;

COMMENT ON COLUMN properties.has_security_system IS
  'Whether the property has a monitored alarm/security system. NULL = never asked; the Safety form''s capture item renders only while it is NULL and writes it on completion. Editable by the PM so an alarm installed later re-enables the annual condition check.';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TWO ITEM-LEVEL GATES
--
-- Deliberately narrow: a text column holding a known fact key, not a general
-- expression language. There is exactly one fact today, and a gate that can
-- express arbitrary predicates is a gate nobody can reason about on a form
-- whose whole value is being auditable.
--
-- An UNRECOGNISED key must behave the way an unrecognised `shown_when_asset`
-- already does — match nothing, render nothing — so a corrupt snapshot degrades
-- to a missing question rather than a crash. That is enforced in the resolver,
-- not here.

ALTER TABLE inspection_form_items
  -- The CAPTURE question: rendered only while the named fact is NULL, and its
  -- answer is what sets the fact. This is the half that "drops off".
  ADD COLUMN IF NOT EXISTS asks_property_fact text,
  -- The CONDITION question: rendered only where the named fact is TRUE. This
  -- half does NOT drop off — see below.
  ADD COLUMN IF NOT EXISTS shown_when_property_fact text;

-- Both name a fact, and the only fact is this one. A CHECK rather than an enum
-- so adding the second fact is a one-line migration, and IN (...) so a typo in
-- a seed is rejected at write time instead of silently never rendering.
--
-- Written with an explicit IS NOT NULL guard on each side. A CHECK passes on
-- NULL — Postgres rejects only on FALSE — so `col IN ('x')` alone would accept
-- anything for a NULL column and, worse, read as though it did not.
ALTER TABLE inspection_form_items
  DROP CONSTRAINT IF EXISTS inspection_form_items_known_property_facts;
ALTER TABLE inspection_form_items
  ADD CONSTRAINT inspection_form_items_known_property_facts CHECK (
    (asks_property_fact IS NULL OR asks_property_fact IN ('has_security_system'))
    AND
    (shown_when_property_fact IS NULL OR shown_when_property_fact IN ('has_security_system'))
  );

-- An item is a capture OR a condition, never both: an item that renders only
-- while the fact is unknown AND only while it is true can never render at all.
-- Cheap to state, and it turns a question that silently disappears into a write
-- that fails.
ALTER TABLE inspection_form_items
  DROP CONSTRAINT IF EXISTS inspection_form_items_fact_gate_exclusive;
ALTER TABLE inspection_form_items
  ADD CONSTRAINT inspection_form_items_fact_gate_exclusive CHECK (
    asks_property_fact IS NULL OR shown_when_property_fact IS NULL
  );

COMMENT ON COLUMN inspection_form_items.asks_property_fact IS
  'Renders only while this property fact is NULL, and its answer sets the fact. The ask-once capture question.';
COMMENT ON COLUMN inspection_form_items.shown_when_property_fact IS
  'Renders only where this property fact is TRUE. The recurring condition question, which deliberately does NOT drop off.';
