# Inspections & Audits — Design Spec

**Status:** draft for review. Nothing here is built yet.
**Owner:** @smj1860. Drafted 2026-08-19.

Automates the PM's quality-control inspections, pre-peak-season property
audits, and safety audits. Three seeded forms, filled on a tablet at the
property, that produce structured findings — and turn a failure into a work
order or purchase order automatically.

---

## 1. Why this is not just a forms feature

Two decisions set the bar and everything else follows from them.

**A failed item creates a work order or a purchase order.** That is what makes
this automation rather than paperwork, and it is why the answers have to be
structured data rather than a document.

**The record is evidence for an insurance discount.** That is a materially
higher bar than an owner-facing PDF: it requires immutability, verified
provenance, and — most importantly — an unbroken *history*. A single audit
earns nothing. Three years of consistent quarterly safety inspections is the
artifact.

The second point has a consequence worth stating plainly: **a complete record
shows the gaps too.** If continuity is the evidence, a missed quarter is
visible and cannot be quietly backfilled. That is the point of immutability,
and it is what gives the overdue nudge its force.

---

## 2. Decisions already made

| Question | Decision |
|---|---|
| Who performs one? | PM or a designated team member. **Not crew.** |
| Failed item does what? | Creates a work order **or** a purchase order, per item. |
| Scope | **Per property.** Individual items may reference an asset. |
| Blocking on safety failure? | **No** — not our call to make, at least for now. |
| Owner portal | Posts **the day it is completed**, failures included, with the WO/PO shown alongside. |
| Overdue | Email the assignee. No escalation path — they are the responsible party. |
| Device | **Tablet/iPad first.** |
| Offline | **In-app**, on the PM dashboard PWA. Not the crew PWA. |
| Offline scope | **Maintenance.** Inspections plus creating a work order — a PM at a property with no signal is doing both on the same visit. Read-only for everything else on the page; see §8. Nothing outside `/maintenance` goes offline. |
| Which forms | Exactly three: **Property Safety & Risk Mitigation**, **Outdoor Property**, **Indoor Property**. |
| Editable by orgs? | **No.** These are FIXED FORMS, not templates. Only the platform changes them. No per-org copy, no editing UI, no Templates Hub. |
| Where it lives | Under **Maintenance** — a tab on the Maintenance page, backed by its own route. Not a top-level nav item, not Templates. |
| Frequency | Set in **onboarding**, changeable later in the Inspections tab. Safety: 1× or 2× a year. Outdoor and Indoor: quarterly or 2× a year. The PM picks the **month(s)** — for quarterly, the month the cycle starts in. |
| Photos | Required on **every failure**, plus specific items that are photographed even when passing (fire-extinguisher tags). |
| Draft lifetime | **24 hours from start.** Past that a new inspection must be started. |
| N/A | Needs a reason. Auto-filled as "property does not have &lt;the thing&gt;" where the item defines one; otherwise the PM writes it. |
| Multi-property | **One property per inspection.** Never batched. |

---

## 3. What already exists and is being reused

Roughly half this feature is conventions the codebase already has. Reusing them
is not a nicety — the dominant defect class here is the same rule existing in
several places and drifting.

**"Generated from X" with idempotency enforced in the schema.** Both target
tables already do this:

```sql
po_source_count_unique              UNIQUE (source_count_id) WHERE NOT NULL
wo_crew_flag_source_unique          UNIQUE (source_turnover_id) WHERE source='crew_flag'
wo_maintenance_schedule_date_unique UNIQUE (source_schedule_id, scheduled_date)
                                      WHERE source='maintenance_schedule'
```

So remediation copies the pattern exactly: a nullable `source_*_id` plus a
partial unique index. A double-submitted inspection **cannot** create two work
orders, because Postgres refuses — not because the application was careful.

**Seasonal + routine scheduling.** `maintenance_schedules` already carries
`schedule_type: 'routine' | 'seasonal'`, `frequency`, `month_due`,
`day_of_month_due`, and `active_from_month` / `active_to_month`. The pre-peak
season audit *is* a seasonal schedule with a month window. There is already a
cron advancing `next_due_date`.

**`work_orders.asset_id`** exists, so an asset-scoped item carries its asset
through to the work order for free.

**`pdf-lib`** is already a dependency, used by `app/api/assets/cpa-export/route.ts`.
No new toolchain for export.

**Owner portal access.** `owner_portal_tokens` is scoped to a
`property_owner_id` with an optional `property_ids[]` and an `is_multi` flag.
Inspections filter to the properties a token already covers. No new access
model.

**Tablet UI precedent.** The crew PWA already uses 48px touch targets and
`<input type="file" accept="image/*" capture="environment">` for camera
capture.

---

## 4. What is NOT being reused, and why

**Not the checklist engine.** `checklist_instances.turnover_id` is `NOT NULL` —
it is hard-bound to turnovers. More fundamentally, a turnover checklist item is
binary *done / not done*, while an inspection item is *pass / fail / N-A* where
fail carries a finding and a remediation. That is a different data model, not a
different label; merging them would put always-null remediation columns on
every turnover checklist row.

To be explicit about the distinction, because this codebase's usual advice is
the opposite: the duplication that keeps causing bugs here is duplicated
**rules** (four copies of a par threshold that drifted into two answers, three
copies of an active-status check). Two genuinely different domain entities that
happen to look similar are not that. **Share the rule, not the table.**

**Not the crew Dexie sync layer.** That layer is complex because it does
bidirectional sync — outbox, cursors, dead-letter queues, reconciliation, and
four guardrail tests policing it. An inspection commits **once**. It needs a
draft store, not a sync engine, and it must live outside `lib/dexie/*` so those
guardrails keep meaning what they say.

---

## 5. Data model

```
inspection_forms                PLATFORM-owned form definition. No org_id.
  id, key, name, kind, description,   -- key: 'safety' | 'indoor' | 'outdoor'
  version, is_active

inspection_form_sections        grouping within a form
  id, form_id, name, sort_order

inspection_form_items           ONE question
  id, section_id, key,   -- stable: 'safety.fire.smoke_present' prompt, sort_order,
  is_required, photo_required,
  response_type       'yes_no' | 'count' | 'date' | 'text' | 'photo'
  failing_answer      'no' | 'yes'      -- DEFAULT 'no'; see below
  parent_item_id      (nullable)        -- shown only when the parent answers <show_when>
  show_when           (nullable)        -- 'fail' | 'pass'
  repeat_source_item_id (nullable)      -- render one row per unit counted there
  na_reason_template  (nullable)        -- "property does not have a pool"
  na_asset_type       (nullable)        -- verify that claim against property_assets
  asset_type          (nullable) -- links the answer to a property_assets row
  repeat_per_asset    boolean DEFAULT false -- one row per ACTIVE asset of asset_type
  concern_key         (nullable) -- same physical concern ACROSS forms; dedup key
  remediation         'none' | 'work_order' | 'purchase_order'  -- now a DEFAULT
  wo_category         (nullable) -- default for a generated WO
  wo_priority         (nullable)
  po_catalog_item_id  (nullable) -- default line item for a generated PO
  po_default_qty      (nullable)

inspections                     ONE performance of a form, per property
  id, org_id, property_id,
  form_id, form_version, form_snapshot jsonb,  -- the form as it was THEN
  assigned_to_user_id,
  inspector_name text,                    -- who PHYSICALLY did it
  scheduled_for date, started_at, completed_at, completed_by_user_id,
  source_schedule_id (nullable)           -- which schedule generated it

inspection_items                ONE answer
  id, inspection_id, org_id,
  form_item_id, prompt_snapshot,
  result 'pass' | 'fail' | 'na',
  actions text[]          -- 'repair' | 'service' | 'replace'; chosen on fail
  needs_cleaning boolean  -- independent of actions; feeds the sign-off roll-up
  note, photo_path,       -- note is REQUIRED when actions is non-empty
  photo_unavailable_reason (nullable) -- free text; the ONLY way past a
                          -- photo_required item without a photo. See §11 q2.
  asset_id (nullable),
  answered_at
```

`form_snapshot` matters for the same reason `checklist_instances` has one:
re-seeding a form must not retroactively change what a completed inspection
says it asked. Orgs cannot edit these forms, but WE can, and a reworded item
shipping in March must not silently rewrite what January's report claims to
have asked.

### Three things the form shapes forced, and one I argued for and withdraw

**WITHDRAWN — `failing_answer`.** I argued for this column on the grounds that
an org editing its own template could write *"Any exposed wiring?"*, which
fails on **Yes**, and silently invert the work-order rule. Orgs cannot edit
these forms. The only author is us, the phrasing is fixed in the seed, and the
column would be defending against a mistake by the same people who would set
its value — which is not a defence, it is a comment with a `DEFAULT`. Dropped.

The underlying hazard is real and does not disappear; it just moves from
runtime to review. **Every item is phrased so that No is the failure**, and
that is a rule for whoever writes the next item, enforced by the seed test in
§10 rather than by a column.

**`parent_item_id` + `show_when`.** "Present in all bedrooms and hallways?
[Y/N] → *if no*, which room needs one?" is two questions where the second only
exists because the first failed. Modelling it as a conditional child rather
than a free-text note keeps the answer STRUCTURED, which is what lets the
generated work order say *"install smoke detector — upstairs hallway"* instead
of pasting a sentence a human has to read.

**`repeat_source_item_id`.** The draft form asks for an extinguisher count and
then lists an expiry date *"3 times in case there are multiple dates"*. Three
is an arbitrary cap that is wrong in both directions — it wastes two rows at
most properties and silently loses the fourth extinguisher at a large one. The
count answer drives the rows instead: `N` extinguishers renders `N` groups of
{location, charged?, expiry, photo}. Same effort to fill, no cap, and each
extinguisher becomes its own auditable line with its own tag photo rather than
a date floating loose from the unit it belongs to.

**`na_asset_type`.** "N/A — no pool at this property" is exactly the assertion
an insurer is entitled to be sceptical of, because the person who benefits from
skipping the pool section is the one making it. FieldStay already knows: pools
and hot tubs are rows in `property_assets`. Where an N/A reason names a thing we
track, the report can say *"N/A — no pool recorded at this property"* and mean
it, and the N/A can be **rejected** at fill time when the ledger disagrees.
That is a materially stronger artifact than free text for the cost of one
nullable column, and it is the whole reason the insurance angle is worth
anything.

### The inspector picks the action — 2026-08-22

`remediation` was going to be fixed per item: the seed decides that a failed
extinguisher is a PO and a failed handrail is a WO, and open question 1 was the
chore of marking `WO`/`PO`/`—` against every one of ~60 items across three
forms.

That chore is now cancelled, and the reason is that it could not have been done
correctly anyway. **The real forms bundle several checks into one prompt** —
*"Refrigeration: fridge and freezer clean, water filter within life, temperature
holding, ice maker functional, compressor working, no leaks, display working"*
is seven conditions on one checkbox. A single `remediation` value cannot serve
it: the filter is a purchase, the compressor is a service call, "clean" is
neither. Splitting it into seven items would fix the data model and wreck the
form, because the inspector looks at the fridge ONCE, not seven times.

So on a fail the inspector picks what is needed, and that is what generates the
record:

| Action | Generates | Notes |
|---|---|---|
| **Repair**   | work order | `wo_category` from the item |
| **Service**  | work order | the vendor-visit flavour of the same thing |
| **Replace**  | purchase order | joins the inspection's single PO |

Cleaning is a **separate checkbox**, not a fourth action in this list, because
it produces neither a WO nor a PO — see the next subsection.

**Multi-select, not one choice.** A dishwasher can have a clogged filter AND a
torn door seal. A water heater at end of life is Replace *and* Service — the
purchase and the install — which is precisely the "needs both" case open
question 1 asked about, now answered by letting the inspector say both rather
than by a rule guessing for them. Each selected action carries the description.

**A description is REQUIRED on fail** and becomes the work order's title. This
is the one place free text beats structure: *"compressor not holding temp,
freezer at 18°F"* is a better work order than any enum we could have written.

**`remediation` survives as a DEFAULT, not a fixed value.** The seed still says
what an item usually means, so the likely action is pre-selected and the
inspector taps once. Keeping it is what preserves our judgment about each item
without binding the person standing in front of the thing.

Safety's structured children (`parent_item_id` / `show_when`, *"which room needs
a smoke detector?"*) stay exactly as they are. Those items are narrow enough
that a structured answer beats prose. Indoor and Outdoor items are broad, and
there the description is the structure. That is a gradient, not a contradiction.

### Deliberate overlap between forms, and the key it needs — 2026-08-22

Open question 5 asked what Indoor and Outdoor must not *both* contain, on the
reasoning that anything asked twice gets two work orders for one fault.

**The premise was wrong, and the decision is to overlap on purpose.** Safety
runs once or twice a year; Indoor and Outdoor run quarterly. Routing smoke
detectors to Safety alone means a dead detector can go six months unnoticed
because the form that asks about it does not run in between. The right answer
is not to deduplicate the *question* — it is to ask it as often as it needs
asking, and deduplicate the *task*.

That needs a key the existing one cannot provide. §6's prompt fires on an open
work order for the same `(property_id, form_item_id)`, and the same physical
concern asked in two forms is two different item ids. So:

```
inspection_form_items
  concern_key  (nullable)   -- 'smoke_detector_operational', 'hvac_filter'
```

Items sharing a `concern_key` are the same physical concern, whatever form they
appear in. §6's open-work-order lookup keys on `concern_key` when one is set and
falls back to `form_item_id` when it is not — so a detector flagged by Safety in
January and by Indoor in April surfaces the January work order rather than
opening a second.

`concern_key` is deliberately narrower than `asset_type`: two different failures
on one HVAC unit (filter due, condenser fouled) are two jobs, and giving them
the same key would merge them. It names a CONCERN, not a thing.

### The property's own assets become items — 2026-08-22

Indoor and Outdoor both end with *"insert any relevant assets the property
has"*, and that is not a copy instruction — it is a rendering rule. A property
with three HVAC units should get three rows; one with no hot tub should not be
asked about a hot tub at all.

```
inspection_form_items
  repeat_per_asset  boolean DEFAULT false   -- with asset_type set
```

An item marked `repeat_per_asset` with `asset_type = 'hvac'` renders once per
ACTIVE `property_assets` row of that type, each answer carrying its `asset_id`
— which `inspection_items.asset_id` already models. Same mechanism as
`repeat_source_item_id`, sourced from the asset ledger instead of a count
answer.

This is the third use of that ledger and the three are worth distinguishing:
`na_asset_type` **verifies an absence** the inspector claims, `repeat_per_asset`
**enumerates a presence** we already know about, and `asset_type` on a plain
item **attributes** one answer to one asset. All three exist so the report can
say something the ledger backs rather than something a person typed.

The payoff beyond the form: a failed asset-scoped item carries `asset_id`, so it
can move that asset's `health_score` and appear in its history. An inspection
becomes an input to asset health rather than a document filed beside it.

### Cleaning is separated from WO/PO, and aggregates

Cleaning is not a fourth kind of work order. Two reasons, and the second is the
one that decides it:

1. It dispatches to **crew**, not to vendors or purchasing.
2. **Cleaning aggregates and repairs do not.** A plumber comes for one fault. A
   cleaner does a list. Carpets to shampoo, an oven to degrease and grout to
   scrub is ONE visit — three cleaning work orders would be three dispatches
   for one job.

So a `Cleaning` action creates nothing on its own. At sign-off the form asks
**"Does additional cleaning need to be scheduled?"**, already answered `yes` if
any item was flagged, with the notes prefilled from those items' descriptions.
The inspector adds whatever the form did not cover — general standard, an
odour, a room that simply needs attention.

The per-item flag matters for two reasons that are easy to miss. Without it a
dirty oven has nowhere to go: the inspector must pick Repair, Replace or
Service, none of which is true, and you get a bogus work order. And a question
asked only at sign-off is answered from memory — an inspector who saw the oven
in section 2 is four sections and twenty minutes away by then, and what they
write will be thinner than what they saw.

The roll-up produces **one** work order, `wo_category = 'cleaning'`, assigned to
a crew member rather than a vendor. `work_orders` already carries
`assigned_crew_member_id` alongside `vendor_id`, so this reuses the board, the
completion flow and the expense posting rather than inventing a parallel
cleaning-task concept. It is deliberately NOT a turnover: turnovers are
booking-driven and an inspection is not, so creating one would mean a turnover
with no checkout behind it.

#### Suggested cleaner count — a guess that is built to stop being one

The roll-up suggests **1 cleaner for 1–3 flags, 2 for 4 or more**.

**That threshold is a guess and the spec should say so.** Flag count is a weak
proxy for effort: *"regrout two bathrooms"* is one flag and half a day, while
*"wipe the fridge, wipe the microwave, dust three fixtures"* is three flags and
twenty minutes. A crude, visibly overridable suggestion is still worth having —
what would not be worth having is one that never improves.

So it records the same three things turnover crew suggestion already records:
what was suggested, the reasoning, and whether the PM accepted or overrode it
(`suggested_crew_ids` / `suggestion_reasoning` / `suggestion_status`, feeding
`assignment_outcomes`). Every override is a sample, and the threshold gets
tuned from real data instead of surviving unexamined because nobody wrote down
what it got wrong.

The PM is shown the **flagged item list**, not just the number. Six item names
with their descriptions is what the decision is actually made on.

The obvious refinement is scaling by property size — a 6-bedroom lodge with 4
flags is not a studio with 4 flags, and `bedrooms` / `square_footage` are both
known. Deliberately not yet: measure the flat threshold first, the same
discipline applied to the par engine's smart groups.

### Immutability

- `completed_at IS NOT NULL` ⇒ **no further UPDATE** on the inspection or its
  items. Enforced in an RLS `WITH CHECK` or a trigger — *not* by hiding a
  button. A UI-only rule is worth nothing as evidence.
- Corrections are a **new inspection referencing the original**, never an edit.
- All timestamps are server-side (`now()`), never client-supplied.

### The one place immutability is subtle

**The finding is immutable; the remediation status is not.** An inspection
completed today creates WO-2026-0031, open. Three days later it is done. A
frozen snapshot would say "open" forever; a live record would not be immutable.

They are two objects. The **finding** is history — what was found, when, by
whom, with photos, locked. The **remediation status** is a live join to the
work order or purchase order. The owner sees:

> Failed — smoke detector, upstairs hallway. WO-2026-0031, completed 2026-08-22.

Consequence to accept: two PDF exports of the same inspection can differ in the
remediation column. Correct behaviour, but exports carry a **generated-at**
stamp so the difference is explainable rather than suspicious.

### Money stays in one place

Work orders carry `actual_cost`, and owner-visible financials already live in
`owner_transactions` with its own `visible_to_owner` flag. The inspection report
**links** to the work order and does not restate cost. Two sources of truth for
what an owner was charged will eventually disagree.

### Retention — close this on day one

There are five retention crons (`audit-retention`, `comms-retention`,
`guest-pii-retention`, `notifications-retention`, `webhook-dedup-cleanup`).
None touches inspections today. A future sweep silently deleting insurance
evidence is unrecoverable, and this codebase has already shipped exactly that
shape of bug — an empty API response deactivating an entire crew roster in one
microsecond.

Inspections go on an explicit retention-exclusion list **with a guardrail
test**, in the same PR that creates the tables. Cheap now, catastrophic later.

---

## 6. Remediation

On completion, each `fail` with `remediation != 'none'` creates its record:

- **work_order** — `source = 'inspection'` (new `wo_source` enum value),
  `source_inspection_item_id`, plus `asset_id` when the item is asset-scoped.
  Idempotency: `UNIQUE (source_inspection_item_id) WHERE source='inspection'`.
- **purchase_order** — `source_inspection_id`, one PO per inspection carrying
  every failed purchasable item as line items.
  Idempotency: `UNIQUE (source_inspection_id) WHERE NOT NULL`.

One PO per inspection rather than per item: a PM who needs three bulbs, a fire
extinguisher and an HVAC filter wants one order, not three.

Generated via Inngest on `inspection/completed` so a partial failure retries
without duplicating — the partial unique indexes are what make the retry safe.

### ON COMPLETION, not on the tick

"A No creates the work order" is the rule, but *when* it fires is a separate
decision and the obvious reading is the wrong one.

An inspector ticks No on a loose handrail, tightens it while standing there,
and changes the answer to Yes. Fire-on-tick has already created the work order,
and now someone has to close it as not-a-thing. Across a form with sixty items
and a 24-hour draft window, that is not an edge case — it is Tuesday. It also
contradicts the owner-portal decision, which is that an inspection publishes
**the day it is completed**: work orders appearing hours before the report they
came from is the wrong story to tell an owner.

So remediation reads the **submitted** answers. Nothing is created while a
draft is open.

### The repeat-visit duplicate, which the partial index does NOT stop

`UNIQUE (source_inspection_item_id)` makes the *retry* safe. It does nothing
about the *next inspection*: a handrail that fails in March and again in June
produces two `inspection_items` with two different ids, so two work orders —
even when the March one is still sitting open, unstarted.

Quarterly inspections make this the normal case rather than a rare one, and the
symptom is a maintenance board that accumulates duplicates until a PM stops
trusting it. Before creating, look for an **open** work order on the same
`(property_id, form_item_id)`; when one exists, attach the new finding to it
(a `work_order_updates` row plus the new photo) instead of opening a second.
The finding is still recorded immutably either way — what is deduplicated is
the *task*, not the *evidence*.

`form_item_id` rather than `wo_category` is the key: two different failures
that both happen to be `wo_category = 'general'` are genuinely two jobs.

#### The action model breaks this key — 2026-08-22

Everything above assumed one item means one fault. Once the inspector picks the
action (see §5), it does not.

*"Refrigeration"* fails in March because the water filter is due — Replace, a
PO. It fails in June because the compressor is not holding temperature —
Service, a work order. Same `form_item_id`, two unrelated problems. The rule
above finds March's open record, calls June a repeat, and **attaches a failing
compressor to a water-filter task as a `work_order_updates` row.** A real fault
disappears into the notes of an unrelated job, and it disappears quietly, which
is the failure mode this codebase produces most often.

Widening the key to `(property_id, form_item_id, action)` helps and does not
fix it: two different Repairs on the same broad item are still two jobs.

**So stop deduplicating silently and ask.** When an item fails and an open work
order from a previous inspection already exists for that
`(property_id, concern_key ?? form_item_id)` — see §5 on `concern_key`, which is
what makes this work across forms that deliberately overlap — show the inspector
what it is:

> Open since 12 Mar — *"replace fridge water filter"*
> Is this the same issue, or a new one?

Strictly better than any key. It cannot wrongly suppress, because the person
answering is standing in front of the appliance; and *"same issue, still open in
June"* is worth recording on its own — it says the March work order has been
sitting untouched for a quarter, which is exactly what a PM should see.

Silent attachment remains correct for the RETRY case, which is what the partial
unique index covers. The prompt governs the repeat-VISIT case, where the two
findings are only related by having been asked the same question.

---

## 7. Scheduling

Reuse `maintenance_schedules` with a discriminator:

```
creates               'work_order' | 'inspection'    (default 'work_order')
inspection_form_id     (nullable)
assigned_to_user_id    (nullable)
anchor_months          smallint[]  (nullable)        -- 1-12, see below
```

`schedule_frequency` already carries `quarterly | semi_annual | annual`, which
covers all three forms exactly — no new enum.

`anchor_months` is the month picking. One value for annual, two for
semi-annual, and for quarterly the **single starting month** from which the
other three derive (+3, +6, +9) — a PM who says "quarterly starting in March"
has said everything, and storing all four would let the set drift out of step
with itself. Array rather than four columns because the validation is then one
CHECK on length against frequency instead of four nullability rules that can
disagree.

Set during onboarding and editable afterwards in the Inspections tab. Both
write the same row; there is no separate onboarding-only shape.

The *timing rule* — when is this due, does it fall inside the seasonal window,
how does `next_due_date` advance — must not exist twice. The output differs;
the timing logic does not.

`assigned_to_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL` is
genuinely new: nothing in the app currently assigns work to an org member.
Everything assigns to crew (`assigned_crew_member_id`) or resolves the primary
admin (`getOrgDispatcher`). Worth doing deliberately — other features will want
it.

---

## 8. Offline, and the trap to avoid

### The 24-hour rule and offline are in tension — resolve it deliberately

A draft dies 24 hours after it starts. A tablet in a basement with no signal
also cannot sync. Put those together and there is a way to lose a completed
inspection: filled offline, carried home, synced at hour 25, rejected.

Three things settle it, and none of them is "hope it syncs":

1. **`started_at` is server time**, stamped when the inspection row is created —
   at assignment or first open, both of which are online. A device clock is
   both skewable and, for an artifact whose entire value is being believed,
   the wrong thing to trust.
2. **Expiry is evaluated at submit**, not by a sweeper. A background job that
   deletes at hour 24 races the sync that would have arrived at hour 24.5.
3. **An expired draft is preserved and marked, never deleted.** The rule is
   that an expired inspection cannot be *submitted as valid* — it is not that
   two hours of a PM's work should be destroyed. They see it, and re-key from
   it into a fresh inspection.

The 24-hour window is there so the evidence is tight: an inspection that took
thirty hours is worth less to an insurer than one that took four. That argument
supports blocking the submission. It does not support throwing the data away.


### Widened from inspections to Maintenance — 2026-08-20

The original scope was inspections alone. It is now the Maintenance page,
because the two are the same trip: a PM standing at a property with no signal
who notices a broken handrail wants to raise a work order, and telling them
"the inspection works offline but the work order does not" is an arbitrary
line drawn by our architecture rather than by their job.

This makes one thing simpler and one thing bigger, and both are worth being
explicit about.

**Simpler:** the bespoke inspection draft store below stops being justified. If
there is an outbox for offline work orders anyway, inspections should use the
same one. Two offline mechanisms in one page is how they drift.

**Bigger:** it is a second sync layer. `lib/dexie/*` is scoped to the crew PWA
and every guardrail around it is crew-shaped — `CREW_SYNCED_TABLES`,
`crew-sync-coverage`, and `crew-dead-letter-coverage`, which enforces that every
member of the `MutationTable` union has a retry affordance in
`app/crew/_components/failed-sync-banner.tsx`. A dashboard outbox built
alongside would be **unguarded by all of them**, which is precisely the "a
mutation that dead-letters where nobody can see it is work silently thrown
away" failure that guardrail exists to prevent.

So: **generalize `lib/dexie` to serve both surfaces, do not fork it.** The
hard-won rules in CLAUDE.md — write and outbox row in ONE transaction, `failed`
as `0 | 1` not boolean, `'x' in payload` presence checks, cursor invalidation on
discard, bounded caches — were each paid for with a production bug. Writing a
second outbox means paying for them twice.

### 8a. Photos — what exists, what moves, what is new

Photo-required-on-fail across a 52-item form, held on a tablet until reconnect,
makes the photo path load-bearing rather than incidental. Three parts.

**Compression already exists and is already correct.**
`compressPhotoForQueue` (`lib/dexie/photo-queue.ts`) resizes to a 1600px longest
edge and re-encodes JPEG at q0.75, falling back to the original blob if
`createImageBitmap` or the 2D context is unavailable. That fallback is the right
call for crew — a codec quirk must not block a checklist — and it is worth
noting that it is a WEAKER guarantee here: an inspection holding twenty
uncompressed 5MB originals in IndexedDB is the case §8's iOS eviction risk is
about. Same function, higher stakes.

**It has to move.** §4 says inspections stay out of `lib/dexie/*` so the crew
guardrails keep meaning what they say, and importing a helper across that line
would erode exactly the boundary that rule protects. But the function is a pure
browser utility — Blob in, Blob out, nothing about Dexie, outboxes or cursors.
It is in that directory by accident of who needed it first.

So move it to `lib/images/compress.ts` and have both surfaces import it. That is
§4's own principle applied to itself: **share the rule, not the table.** Two
copies of a resize threshold is precisely the drift this codebase keeps paying
for — and a second copy would be invisible, because both would work.

**The bucket is new.** Six exist today; none fits:

| Bucket | Public | Limit | Why not |
|---|---|---|---|
| `crew-uploads` | **yes** | 10MB | public, and crew-scoped |
| `turnover-photos` | no | 10MB | bound to a turnover |
| `work-order-photos` | no | 10MB | bound to a work order |
| `compliance-documents` | no | 10MB | vendor compliance |
| `guidebook-*` | yes | 5MB | guest-facing |

Add `inspection-photos`: **private**, 10MB, `image/jpeg png webp heic`, mirroring
`work-order-photos`. Paths go through `orgScopedStoragePath()` like every other
org-scoped bucket — the `org-scoped-storage-paths` guardrail already enforces
that and will cover the new bucket for free once it is listed.

HEIC is in the allowed list because iOS sends it, but compression re-encodes to
JPEG before upload, so a HEIC only reaches the bucket on the fallback path.

**`crew-uploads` was public; closed 2026-08-22 while writing this section.**
Traced rather than deferred, and the honest finding is narrower than it first
looked: the bucket held ZERO objects, had NO storage.objects policies, and
nothing in `app/` or `lib/` uploaded to it — a fact already recorded in
`20260731100000_db_invariant_report_storage_bucket_ids.sql`. Public with nothing
in it discloses nothing, and with no policies the client could not write to it
either. There was no leak.

It was a trap with an inviting name. Crew photos actually go to
`turnover-photos` and `work-order-photos`, both private and both covered by the
semgrep chokepoint banning `getPublicUrl()`; `crew-uploads` sat outside that
rule *because* it was public, so nothing was watching it. It is now private
(`20260822054254_crew_uploads_private.sql`), leaving only the two guest-facing
guidebook buckets public, which is correct.

Worth stating for the inspections build specifically: **no photo has ever been
uploaded in production** — all six buckets are empty. So the pipeline described
above has never run under real load, and the compression fallback path in
particular is untested against a real device camera.

### Offline WRITES are CREATE ONLY

The line that keeps this affordable, and it is not a limitation of effort:

- **Create a work order offline** — safe. It is a new row nobody else can be
  touching, so there is no conflict to resolve. Queue it, push it on reconnect.
- **Edit or complete an existing work order offline** — NOT in scope. The
  maintenance board is shared: a PM, a second PM and a vendor portal can all
  touch one work order. Last-write-wins across a six-hour offline gap silently
  reverts whatever happened while the tablet was in a basement, and neither
  party ever learns. The crew PWA avoids this because a crew member effectively
  owns their turnover; nobody owns a work order.

Everything else on the page is **readable** offline and visibly read-only. A
disabled control with "needs a connection" is a fine answer; a control that
appears to work and silently loses the change is not.

### Work-order numbers cannot be assigned offline

`wo_number_counters` is a per-org server-side sequence. A device cannot draw
from it while offline, and pre-allocating blocks per device buys gaps and
complexity for nothing.

The number is assigned **at sync**. Until then the local record shows no
number — not a provisional one. A number that changes after the fact is worse
than no number: it is the identifier a PM reads down the phone to a vendor.

### IndexedDB outlives the session

Caching dashboard data client-side is new, and the dashboard holds more than
the crew PWA does — costs, vendor contacts, owner-adjacent detail. IndexedDB
survives sign-out unless something explicitly clears it, so a PM removed from an
org keeps a readable copy of that org's maintenance board on their tablet
indefinitely.

The cache is therefore keyed per user AND per org, cleared on sign-out, and
cleared on org switch. This needs to be built in phase 1 rather than
retrofitted, because the version that "works" without it looks identical.

### Service worker scope

### CORRECTION — the dashboard already has a service worker, at root scope

An earlier draft of this section said "the dashboard PWA has no service worker
today" and warned against registering one dashboard-wide. **Both halves were
wrong, and the thing they warned about is already live.**

`components/dashboard-shell.tsx` wraps the entire dashboard and calls
`useDashboardPushNotifications()`. That hook calls
`navigator.serviceWorker.register('/sw.js')` **on mount, unconditionally** —
before any permission prompt, before any opt-in, for every PM who loads any
page. There is no `scope` option, so the scope defaults to the script's
location: **`/`**. The whole origin.

And `/sw.js`'s navigate handler has no path allowlist:

```js
if (request.mode === 'navigate') {
  fetch(request).then((response) => {
    if (response.ok && !response.redirected) cache.put(request, copy)   // every page
  }).catch(() => caches.match(request, { ignoreVary: true }))           // served when offline
}
```

So every dashboard page a PM has ever loaded is cached and is served back to
them when the network fails. `Cache-Control: private, no-cache, no-store` does
not prevent it — the Cache API is not the HTTP cache and `cache.put()` ignores
those headers.

**The consequence is exactly the failure this section was written to prevent:**
a PM at a property with no signal opens `/ops` and gets yesterday's board
rendered as if it were current, with nothing saying otherwise. Not
hypothetical, not a risk of the inspections work — today's behaviour, arriving
as a side effect of push notifications.

### What that changes about the plan

The job is **not** to add a service worker to the dashboard. It is to replace an
accidental, unscoped one with a deliberate one — which is a smaller and more
honest piece of work, and it comes with a bug fix attached.

**One worker, with an explicit path allowlist.** Not two registrations:

- Two workers cannot both control a page, and a registration is keyed by
  **scope**. Registering a second script at scope `/` would not sit alongside
  `/sw.js` — it would REPLACE it. On a device with both the crew PWA and the
  dashboard installed (a PM who also cleans), the two would overwrite each
  other's registration on alternate loads.
- The push subscription lives on a registration. Churning the registration
  churns the subscription.

So `/sw.js` stays the single origin-wide worker and gains a rule it should
always have had: **offline-capable only under an explicit allowlist —
`/crew` and `/maintenance` — and network-only everywhere else, with no cache
fallback.** Everything outside the allowlist then fails visibly offline instead
of silently serving yesterday.

That single change both enables the feature and closes the staleness bug.

A bad service worker remains the worst kind of bug in a PWA — sticky, surviving
a redeploy, able to make the app unloadable for a user who cannot be reached.
The allowlist is what bounds the blast radius now that scope cannot.

**This weakens an argument I made earlier.** §9a justified a real
`/maintenance/inspections` route partly because a service worker cannot be
scoped to a query parameter. With the whole of `/maintenance` scoped, a
`?tab=` would in fact be covered. The route is still the right call — back and
forward, bookmarks, and a URL the overdue email can link to — but that is a
weaker set of reasons than the one I gave, and the earlier framing should not
be read as still load-bearing.

**Do not register the existing `/sw.js` on the dashboard.** Its navigate
handler caches every page returning 200, with no path scoping:

```js
if (response.ok && !response.redirected) cache.put(request, copy)
```

Registered dashboard-wide, every page a PM visits becomes offline-capable — so
a PM at a property with no signal opens `/ops` and gets yesterday's turnover
board rendered as current. Silent staleness, arriving as a side effect of a
feature that never asked for it.

**Rejected alternative:** a separate `/maintenance-sw.js` scoped to
`/maintenance/`. It reads cleanly — narrower than its own location, so
permitted, and most-specific scope wins — but it leaves `/sw.js` still
root-scoped and still caching every other dashboard page, so the staleness bug
survives the fix. Two workers to solve a problem one worker caused is the wrong
shape.

### Local store — one mechanism, not two

**SUPERSEDED.** This section originally specified a self-contained draft store
outside `lib/dexie/*`, on the reasoning that an inspection commits atomically
and therefore needs no outbox, cursors or reconciliation. That was correct for
inspections alone. It is not correct now: offline work-order creation needs a
real outbox, and running a bespoke draft store beside it would mean two
offline mechanisms on one page, two dead-letter surfaces, and two places to
get the same transaction rule wrong.

Inspections use the same outbox. What was going to be a special case becomes
one more mutation type:

- Cached for reading: properties, vendors, assets, maintenance schedules, open
  work orders. All bounded by the org's plan-capped property count — at 50
  properties that is roughly 1,050 assets and 900 schedules, which is
  comfortable for IndexedDB, and both figures come from the live per-property
  ratios measured during the `-org-scoped` semgrep audit rather than a guess.
- Queued for writing: a new work order, and an inspection submission.
- Photo blobs go through the `pending_photo_uploads` pattern the crew PWA
  already has, for both.
- An inspection still submits as **one** atomic completion. That property is
  about the inspection's own semantics and survives the change of mechanism.

### iOS risk, stated rather than buried

Safari can evict storage from installed PWAs under pressure. The UI must show
clearly and continuously when work is **held on this device** versus
**submitted**, and the local store must be genuinely durable. This is the
single biggest technical risk in the feature and the thing most likely to force
a rethink after real-hardware testing.

Widening the scope to work orders raises the stakes rather than changing them.
An evicted inspection draft is a wasted visit; an evicted work order is a
repair nobody knows was requested. Both need the same treatment — visible
held-on-device state, and a dead-letter surface a PM can actually reach — which
is the argument for one outbox with one banner rather than two.

### The blank PDF still exists

For a team member who will not use a tablet, a property with no device, or a
fallback when something breaks. It is the backup path, not the primary one — a
filled-in PDF cannot trigger a work order, cannot carry photos, and has no
server-verified identity or timestamp.

---

## 9. Surfacing

- **Nav** — `/maintenance` becomes "Maintenance & Inspections" with an
  Inspections tab. ⚠️ Check the label does not wrap in `components/bottom-nav.tsx`
  on a phone before committing to it.
- **Dashboard** — an Upcoming Inspections section, hidden until an inspection is
  within 30 days. `app/(dashboard)/ops/page.tsx` already computes
  `addDays(today, 29)`. Overdue stays visible and is styled as overdue.
- **Owner portal** — posts on completion, failures included, each with its
  linked WO/PO and that record's current status.
- **Maintenance** — where inspections are started, filled and reviewed. See
  §9a; this is a real nested route rendered as a tab, not a query parameter.

### 9a. Where it lives, and why the URL is not a detail

Under **Maintenance**. Not Templates — nothing here is a template — and not a
top-level nav item.

**A real nested route, `/maintenance/inspections`, rendered as a tab.** The
choice between "a tab" and "a submenu item" looks cosmetic and is not, for one
reason: this is the only offline surface in the dashboard PWA, and **service
worker scope is path-based**. A service worker can be registered for
`/maintenance/inspections` and control exactly that subtree. It cannot be
scoped to `/maintenance?tab=inspections`, because a query string is not part of
the scope — so a tab implemented as a parameter would either take the whole
Maintenance page offline or nothing at all. §8's scoped-service-worker
decision was what forced a path here — see the note at the end of §8: once the
whole of `/maintenance` is scoped, that argument no longer holds and the route
survives on its weaker reasons.

So: a real route, presented in a `Tabs` bar on the Maintenance page. Visually a
tab, structurally a path. It also gets back/forward, bookmarking, and a link the
overdue email can point at, none of which a parameter tab gives for free.

`components/ui/Tabs.tsx` exists and already carries `role="tablist"`,
`aria-selected` and a focus ring — Maintenance has no tab bar today, so this
adds the first one and must use that primitive rather than hand-rolling
(CLAUDE.md, and `check:ui-classes` will not catch a hand-rolled equivalent).

**No nav change.** `NavItem` in `lib/navigation.ts` is a flat list with no
children, so a genuine sidebar submenu would mean adding nesting to the sidebar
renderer for a single entry. A tab needs nothing.

### Phase 0 shipped — two corrections to what it was scoped as

**`/work-orders/` had to be in the allowlist.** `app/work-orders/[token]/
register-service-worker.tsx` registers `/sw.js` deliberately, and its comment
says why: a vendor who loses signal and hard-reloads got nothing before,
because nothing in that route tree registered a worker. It depends on exactly
the unscoped caching this change removes. A two-path allowlist would have
broken a feature silently.

**`/maintenance` had to be OUT of it.** Allowlisting it now would cache
maintenance pages with no local store behind them and no held-on-device state —
the same staleness being removed everywhere else, narrowed to one page. It goes
in with phase 2a, when there is something to be stale *against*.

The push half was smaller than expected for a good reason: the crew copy had
already been hardened against all three defects. The work was deleting the
dashboard's copy, not inventing a fix.

### Where the form definition lives

The three forms are platform-owned data with no org copy. Two candidate homes,
and this repo has already answered the question twice.

`inventory_catalog` and `asset_type_standards` are global seed tables — rows in
Postgres, no `org_id`, written by migration. That is the precedent for shape.
But wording changes to an inspection item are frequent early and a migration
per typo is a bad trade.

`scripts/seed-support-kb.ts` is the precedent for *process*: the content lives
in the repo, a script projects it into the database, and
`.github/workflows/seed-support-kb.yml` re-runs it when the source file
changes. Reviewable in a pull request, versioned in git, and still real rows
with real foreign keys at the other end.

**Both.** Definition in the repo as the source of truth; a seed script projects
it into `inspection_forms` / `_sections` / `_items`; CI re-seeds on change. That
keeps the `form_item_id` foreign key that the repeat-visit dedup (§6) and any
"this item has failed three quarters running" report depend on, without a
migration to change a comma.

The seed is **upsert by `key`**, never delete-and-recreate: `inspection_items`
reference these rows, and re-creating them with new ids would orphan every
answer ever recorded. `key` is the stable identity; the row id is not.

### Overdue email — wording is the owner's call

The email should say the inspection is overdue, that it is visible in the owner
portal, and that it forms part of the inspection history presented to an
insurer.

⚠️ It should **not** predict what an insurer will do. "Insurance may not cover
you" is an automated claim about a third party's future behaviour, sent under
FieldStay's name. State the facts and let the reader draw the conclusion — same
motivating force, no exposure. **This copy must be written or approved by
@smj1860, not drafted by an engineer.**

---

## 10. Phasing

| # | Phase | Contents |
|---|---|---|
| 1 | Schema + immutability | Tables, completion lock, retention exclusion + guardrail, `assigned_to_user_id` |
| 2 | The three forms | Definition in the repo, seed script + CI re-seed, upsert by `key`. Includes the seed test: every item phrased so No is the failure, every item has a WO/PO/— decision, no two forms ask the same thing |
| 0 | SW allowlist + push parity | **DONE.** `/sw.js` gained an explicit offline allowlist — `/crew` and `/work-orders/`, NOT `/maintenance` (see below); everything else gets the offline page rather than a stale cached copy. Push subscription unified into `lib/push/subscribe-client.ts`, fixing the dashboard's `if (existing) return` that had left zero PM rows ever |
| 2a | Offline foundation | Generalize `lib/dexie` beyond the crew PWA; per-user+org cache with sign-out and org-switch clearing; extend the dead-letter and sync-coverage guardrails to the new surface |
| 3 | Fill + complete | Tablet UI at `/maintenance/inspections`, offline WO create, photos |
| 4 | Remediation | fail → WO/PO with partial-unique idempotency |
| 5 | Scheduling | `maintenance_schedules` discriminator |
| 6 | Surfacing | 30-day dashboard section, overdue email, owner portal |
| 7 | Export | History PDF via `pdf-lib`, copying the CPA export |

1–4 are the feature. 5–7 are what make it automatic.

---

## 11. Open questions

The five original questions are answered and have moved into §2. These are the
ones those answers raised, and each is a judgment call rather than something a
reader of the spec can settle.

1. ~~**WO or PO, per item.**~~ **CLOSED 2026-08-22.** The inspector picks
   `Repair` / `Service` / `Replace` — multi-select, with a required description
   — and that generates the record. See §5. This did not just answer the
   question, it dissolved it: the real forms bundle several checks into one
   prompt, so no single per-item value could have been correct. "Needs both" is
   now expressible rather than arbitrated: Replace + Service on one item is the
   purchase and the install.

2. ~~**The photo-on-fail escape hatch.**~~ **CLOSED 2026-08-22 — have it.**
   `inspection_items.photo_unavailable_reason`, free text with no preset
   options so it cannot be tapped through, and printed on the report wherever
   an image would otherwise sit. An insurer seeing three of those in a year
   draws the right conclusion; an insurer seeing three photos of a floor does
   not, and a floor photo is exactly what an unenforceable rule produces.
   See §8a for the pipeline this depends on.

3. ~~**Who counts as a "designated team member".**~~ **CLOSED 2026-08-22, and
   simpler than the question assumed.** "Team members" is the FieldStay UI term
   for the people a PM invites, who hold near-identical access to the PM. Any
   of them may be assigned an inspection. No `can_inspect` flag, no companion
   permission — `assigned_to_user_id` is a FILTER over the org's non-crew,
   non-viewer members and nothing more.

   The part that removes the remaining complexity: **whoever the PM physically
   hands the tablet to is a designated team member, FieldStay account or not.**
   That is the PM's call and not something the product adjudicates. It does
   mean the person inspecting is not necessarily the signed-in user, which
   §5 resolves by recording both.

4. ~~**Inspector title.**~~ **CLOSED 2026-08-22 — dropped entirely.** No title
   on the form, no column, nothing added to `profiles`. Inspector NAME only.
   The whole question existed to serve a header field that turned out not to be
   wanted, which is the cheapest possible resolution.

5. ~~**What "Indoor" and "Outdoor" must not both contain.**~~ **CLOSED
   2026-08-22, and the premise was wrong.** Overlap is DELIBERATE: Safety runs
   1–2×/year while Indoor and Outdoor run quarterly, so routing detectors and
   shut-offs to Safety alone lets a dead detector sit for six months. The fix
   is not to ask the question once — it is to ask it on the faster cadence and
   deduplicate the TASK, via `concern_key` (§5) driving §6's open-work-order
   prompt. What remains is an authoring rule rather than a question: every item
   duplicated across forms must carry a shared `concern_key`, checked by the
   seed test in §10.

6. ~~**Versioning a fixed form.**~~ **CLOSED 2026-08-22, both halves.**

   An inspection in progress when a new version seeds **keeps the version it
   started on**. `form_snapshot` already guarantees the questions; this makes it
   a stated rule rather than an emergent property, so nobody later "fixes" a
   draft to match current.

   The version **is shown** — in the owner portal history and on every stored
   inspection, not only the current one. For an insurance artifact this is the
   difference between a document and a record: if v2 asked 20 questions and v3
   asks 24, a three-year history that does not say which was used reads as
   inconsistent inspecting rather than an improving form.

---

## 12. The three forms

`WO` = work order on fail · `PO` = purchase order on fail · `—` = record only
Asset column links the answer to a `property_assets` row.

### 12.1 Property Safety & Risk Mitigation Inspection

Frequency: 1× or 2× a year, month(s) chosen by the PM.

**Header** — prefilled and locked, not typed: property name/ID, physical
address, inspection date, start time, inspector (the signed-in user),
management company (the org). See open question 4 on inspector title.

#### 1. Fire Safety & Life Safety Systems

| # | Item | Type | Fail | Asset |
|---|---|---|---|---|
| 1 | Smoke detectors present in all bedrooms and hallways | yes_no | WO | — |
| 1a | → Which room needs a smoke detector? | text | — | — |
| 2 | Smoke detectors tested and operational | yes_no | WO | — |
| 2a | → Which room's detector failed the test? | text | — | — |
| 3 | CO detectors installed on every level with sleeping areas | yes_no | WO | — |
| 3a | → Which level needs a CO detector? | text | — | — |
| 4 | CO detectors operational | yes_no | WO | — |
| 4a | → Which level's detector failed the test? | text | — | — |
| 5 | Number of fire extinguishers | count | — | — |
| 5a | → Location (one row per extinguisher) | text | — | — |
| 5b | → Fully charged | yes_no | PO | — |
| 5c | → Expiration date | date | PO | — |
| 5d | → Tag photo | photo | — | — |
| 6 | Exit doors and pathways clear and fully operational | yes_no | WO | — |
| 6a | → Photo of each exit | photo | — | — |
| 7 | Emergency lighting / flashlights present and functional | yes_no | PO | — |
| 7a | → Location | text | — | — |

Items 5a–5d repeat once per extinguisher counted in 5 — see
`repeat_source_item_id` in §5. Item 5d is `photo_required` even on a pass:
extinguisher tags are photographed every time, which is the one place a
passing item still produces evidence.

#### 2. Electrical & Utility Safety

| # | Item | Type | Fail | Asset |
|---|---|---|---|---|
| 8 | GFCI outlets installed and functional in all wet areas (kitchen, baths, exterior, hot tub) | yes_no | WO | `electrical_panel` |
| 9 | Electrical panel unobstructed, no exposed wiring, no tripped breakers | yes_no | WO | `electrical_panel` |
| 10 | Main water shut-off labelled, accessible, valve tool in place | yes_no | WO | `plumbing_system` |
| 11 | HVAC air filters clean, supply vents unblocked, service log current | yes_no | PO | `hvac` |

#### 3. Structural, Floor & Slip/Trip Hazard Mitigation

| # | Item | Type | Fail | Asset |
|---|---|---|---|---|
| 12 | Handrails secure; treads slip-resistant and clear | yes_no | WO | — |
| 13 | Walkways and driveways level, clear of trip hazards, algae, ice | yes_no | WO | — |
| 14 | Flooring sound — no torn carpet, loose tile or warped boards | yes_no | WO | — |
| 15 | Deck and balcony guardrails sound; posts secure; spindle spacing compliant | yes_no | WO | `deck_structure` |

#### 4. Water Leak & Freeze Damage Prevention

| # | Item | Type | Fail | Asset |
|---|---|---|---|---|
| 16 | No active leaks under sinks, behind toilets, around the water heater | yes_no | WO | `water_heater` |
| 17 | Braided stainless washing-machine supply lines fitted (not rubber) | yes_no | PO | `washer` |
| 18 | Leak sensors installed at water heater, sump pump, washing machine | yes_no | PO | — |
| 19 | Gutters and downspouts clear, draining away from the foundation | yes_no | WO | — |

#### 5. Exterior, Amenity & Security Risk Controls

| # | Item | Type | Fail | Asset |
|---|---|---|---|---|
| 20 | Exterior lighting functional at every entryway | yes_no | WO | — |
| 21 | Grills and fire pits at safe distance from structures; gas shut-offs marked | yes_no | WO | — |
| 22 | Pool / hot tub fencing, self-closing gates and safety covers latch securely | yes_no | WO | `hot_tub` |
| 23 | Exterior deadbolts and smart locks secure; keyless codes tested | yes_no | WO | `smart_lock` |

Item 22 carries `na_asset_type = 'hot_tub'`: a property with no pool or hot tub
recorded skips it with a reason the asset ledger backs, per §5.

**Still to come:** Outdoor Property Inspection and Indoor Property Inspection,
in this shape. The two drafts below are the FIRST-PASS guesses and are kept
only until the real ones arrive.

### 12.2 Indoor Property & Inventory Inspection

Quarterly or 2× a year, month(s) chosen by the PM.

**Header** — prefilled and locked, exactly as Safety: property name/ID, physical
address, date, start time, inspector (signed-in user), management company.

**On every failed item:** one or more of `Repair` / `Service` / `Replace`, each
with a REQUIRED description, plus an independent `Cleaning` checkbox that feeds
the sign-off roll-up. See §5. The `Dflt` column below is the pre-selected
action, not a constraint — the inspector overrides it freely.

**Overlaps with Safety are DELIBERATE.** Safety runs 1–2×/year and this runs
quarterly; routing detectors and shut-offs to Safety alone lets a dead detector
sit for six months. Every overlapping item carries a `concern_key` shared with
its Safety twin, so the *question* is asked on the faster cadence while the
*work order* is deduplicated across both forms (§5, §6).

#### 1. Entryway, Hallways & General Interior

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 1 | Entry locks and hardware — smart lock responds, latch aligned, deadbolt operates | yes_no | Repair | `smart_lock` | `entry_lock_operational` |
| 2 | Walls, trim and ceilings — no holes, cracks, water staining or scuffed baseboards | yes_no | Repair | — | — |
| 2a | → Touch-up paint or patching needed | yes_no | Repair | — | — |
| 3 | Flooring and rugs — clean, no chips, warping or slip hazards | yes_no | Repair | — | `flooring_sound` |
| 3a | → Shampoo, reseal or re-coat needed | yes_no | Service | — | — |
| 4 | Doors and windows — lock, glass intact, screens present, tracks clear, weatherstripping sound | yes_no | Repair | — | — |
| 5 | Bedroom egress windows open fully from inside without a tool | yes_no | Repair | — | `egress_window` |
| 6 | Window coverings — blinds and curtains operate, clean, cords secured out of child reach | yes_no | Replace | — | — |
| 7 | Ceiling fans — balanced, no wobble, both directions and all speeds work | yes_no | Repair | — | — |
| 8 | Mirrors, wall art and shelving securely mounted | yes_no | Repair | — | — |
| 9 | Interior stairs and handrails secure; treads sound | yes_no | Repair | — | `handrail_secure` |
| 10 | Tall furniture and wall-mounted TVs anti-tip anchored | yes_no | Repair | — | `furniture_anchored` |
| 11 | Attic or ceiling access hatch — closes properly, no staining around it | yes_no | Repair | — | — |
| 12 | No musty, damp or sewer odour anywhere in the unit | yes_no | Service | — | — |
| 12a | → Where is the odour strongest? | text | — | — | — |
| 13 | HVAC — thermostat connected, temperature stable, filter clean, vents clear, coils clean | yes_no | Service | `hvac` | `hvac_filter` |

Item 12 is not cosmetic. Odour is the earliest leak and mildew indicator on the
form, and the one finding most likely to reach a review before it reaches a PM.

#### 2. Kitchen & Dining

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 14 | Refrigeration — clean, holding < 40°F / < 0°F, ice maker works, no leaks, display works | yes_no | Service | `refrigerator` | — |
| 14a | → Water filter within its service life | yes_no | Replace | `refrigerator` | `fridge_water_filter` |
| 15 | Stove, oven and exhaust — burners and drip pans clean, oven light works, elements heat, hood fan and light operate | yes_no | Service | `oven_range` | — |
| 16 | Dishwasher — filter clean, spray arms clear, door seal intact, drains fully, no leaks | yes_no | Service | `dishwasher` | — |
| 17 | Microwave — clean, turntable and door latch work, heats | yes_no | Replace | `microwave` | — |
| 18 | Small appliances — coffee maker, toaster, kettle, mixer clean, cords undamaged, all operate | yes_no | Replace | — | — |
| 19 | Plumbing and under-sink — aerator clear, disposal works, supply lines and drain DRY, no slow drains | yes_no | Repair | `plumbing_system` | `under_sink_leak` |
| 19a | → Whole-home water filter within its service life | yes_no | Replace | — | `home_water_filter` |
| 20 | Cookware, dinnerware and flatware counted against the property's inventory list | count | — | — | — |

**Item 20 is a link, not a checkbox.** Counts against par already have a whole
machine behind them — `inventory_items.par_level`, the count flow, auto-PO below
par, the Kroger cart. Asking it again here would give you two systems answering
"are we short on flatware", and the inspection's answer would bypass the tested
restock path. The item records THAT a count was performed and links to it; the
count itself does the restocking. Same for linens in §4.

#### 3. Bathrooms & Plumbing

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 21 | Sinks and faucets — pressure adequate, hot water delivers, stoppers work, zero under-sink leaks | yes_no | Repair | `plumbing_system` | `under_sink_leak` |
| 22 | Toilets — flush cycle tested, fill valve shuts off, base anchored, supply line dry | yes_no | Repair | `plumbing_system` | — |
| 23 | Shower and tub — grout and caulk intact, drains flow, no mineral buildup, grab bars secure, doors track properly | yes_no | Repair | — | — |
| 24 | Bathroom exhaust fans — blades clean, pull verified | yes_no | Replace | — | — |
| 25 | GFCI outlets in every wet area test and reset correctly | yes_no | Repair | `electrical_panel` | `gfci_wet_areas` |

#### 4. Bedrooms & Sleeping Areas

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 26 | Beds and frames — joints stable, headboard secure, slats undamaged | yes_no | Repair | — | — |
| 27 | Mattresses — protector present and clean, no wear, sagging or staining | yes_no | Replace | — | — |
| 28 | Closets and storage — hangers stocked, luggage racks sturdy, safe operational | yes_no | Replace | — | — |
| 29 | Linens, towels and bedding counted against the property's inventory list | count | — | — | — |
| 30 | Smoke detector present and operational in every bedroom and hallway | yes_no | Repair | — | `smoke_detector_operational` |
| 31 | CO detector operational on every level with sleeping areas | yes_no | Repair | — | `co_detector_operational` |

Items 30 and 31 share their `concern_key` with Safety items 1–4. Asked here
because this form runs quarterly and Safety does not.

#### 5. Living Areas, Furniture & Electronics

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 32 | Upholstered furniture — firm, clean, no stains, tears or frame wobble | yes_no | Repair | — | — |
| 33 | Tables and case goods — sturdy, no loose legs, sharp edges or surface damage | yes_no | Repair | — | — |
| 34 | TVs and entertainment — display and sound work, remotes present, streaming reset to the guest screen | yes_no | Replace | — | — |
| 35 | Wifi — router and modem operational, speed test meets the advertised rate | yes_no | Service | — | `wifi_operational` |
| 36 | Posted wifi credentials and guidebook details match reality | yes_no | Repair | — | — |
| 37 | Lighting and outlets — all bulbs work, no frayed cords, switches operate, wall plates uncracked | yes_no | Replace | — | — |
| 38 | Battery sweep — detectors, smart locks, thermostats, noise sensors, remotes all above low-battery warning | yes_no | Replace | — | `battery_sweep` |
| 39 | Noise monitors and cameras — powered, reporting, and sited only in permitted areas | yes_no | Service | — | — |

Item 38 is one line covering a whole class of guest complaint, and it is the
item most likely to prevent a mid-stay call-out. Item 39's second clause is a
compliance check, not a functional one: a camera in the wrong room is a listing
violation on every major channel.

#### 6. Utility, Laundry & Access

| # | Item | Type | Dflt | Asset | concern_key |
|---|---|---|---|---|---|
| 40 | Washer — drum clean, drain hose clear, all cycles run, inlet filters clean | yes_no | Service | `washer` | — |
| 41 | Washer supply lines braided stainless, not rubber; no weeping at either end | yes_no | Replace | `washer` | `washer_supply_lines` |
| 42 | Dryer — lint trap clear, vent hose connected, exit point free of lint | yes_no | Service | `dryer` | `dryer_vent_clear` |
| 43 | Water heater — set to ≤ 120°F, TPR valve clear, no corrosion or moisture at the base | yes_no | Service | `water_heater` | `water_heater_condition` |
| 44 | Main water shut-off labelled, accessible, valve tool present | yes_no | Repair | `plumbing_system` | `main_shutoff` |
| 45 | Electrical panel unobstructed, labelled, no tripped breakers or exposed wiring | yes_no | Repair | `electrical_panel` | `electrical_panel_clear` |
| 46 | Access inventory — spare keys, lockbox codes and garage remotes all present and tested | yes_no | Replace | — | — |
| 47 | Indoor bins present, clean and undamaged | yes_no | Replace | — | — |
| 48 | Zero signs of pest activity in cabinets, corners and baseboards | yes_no | Service | — | `pest_activity` |
| 48a | → Pest control contract current and visits on schedule | yes_no | Service | — | — |

Items 41–45 carry `concern_key`s shared with Safety items 9, 10, 16 and 17.

#### 7. Property Assets

Rendered from the ledger, not written here. Every ACTIVE `property_assets` row
whose `asset_type` is not already covered above produces one row —
`repeat_per_asset` in §5 — so a property with three HVAC units is asked three
times and one with no generator is never asked about a generator.

| # | Item | Type | Dflt | Asset |
|---|---|---|---|---|
| 49 | *(per asset)* — operational, no visible damage, no unusual noise or smell | yes_no | Service | *(the asset)* |
| 49a | → Serial/model plate photo | photo | — | *(the asset)* |

#### Sign-off

| # | Item | Type | Notes |
|---|---|---|---|
| 50 | Does additional cleaning need to be scheduled? | yes_no | Pre-answered `yes` if any item was flagged Cleaning; notes prefilled from those descriptions |
| 50a | → What needs cleaning | text | Optional; the prefill is usually enough |
| 51 | Certification — inspection completed on-site; all exceptions recorded with photos | yes_no | `is_required` |
| 52 | Inspector signature | photo | `is_required` |

Item 50 produces at most ONE work order, `wo_category = 'cleaning'`, crew-
assigned, with the suggested cleaner count from §5.

**Photo policy:** `photo_required` on fail for every item in §1–§6, plus item
49a on a pass. See open question 2 on the unavailable-camera escape hatch —
still open, and this form makes it more pressing rather than less.

### 12.3 Outdoor Property Inspection — SUPERSEDED FIRST PASS, awaiting the real form

Quarterly or 2× a year, month(s) chosen by the PM. Same status as 12.2.

| # | Item | Fail | Asset |
|---|---|---|---|
| 1 | Roof — no visible damage, missing shingles or debris | WO | `roof` |
| 2 | Gutters clear and secure; downspouts directed away from foundation | WO | — |
| 3 | Siding, trim and exterior paint condition | WO | — |
| 4 | Foundation — no visible cracks or settling | WO | — |
| 5 | Walkways and driveway free of trip hazards | WO | — |
| 6 | Deck/patio surface and railings sound | WO | `deck_structure` |
| 7 | Outdoor furniture condition and count | PO | — |
| 8 | Grill clean and operational; propane level adequate | PO | — |
| 9 | Fire pit area safe and clear; tools present | WO | — |
| 10 | Landscaping trimmed; nothing overhanging roof or utility lines | WO | — |
| 11 | Irrigation functioning with no leaks | WO | — |
| 12 | Exterior outlets have weatherproof covers; GFCI tested | WO | — |
| 13 | Pool equipment operational; chemistry in range | WO | `pool_pump` |
| 14 | Hot tub operational; cover in good condition | WO | `hot_tub` |
| 15 | Dock and waterfront structure sound (if applicable) | WO | — |
| 16 | Fencing and gates secure and self-latching | WO | — |
| 17 | Exterior and path lighting operational | PO | — |
| 18 | Hose bibs no leaks; freeze protection in place seasonally | WO | — |
| 19 | Trash and recycling area tidy; bins in good condition | PO | — |
| 20 | Septic or well access clear and marked (if applicable) | WO | `septic_system` |
| 21 | Snow and ice equipment staged (seasonal) | PO | — |

---

## 13. Notes for whoever builds this

- Every new table gets RLS enabled with real SELECT/INSERT/UPDATE/DELETE
  policies in the same migration, plus the `authenticated` GRANT.
- `types/database.ts` updates in the same commit as each migration.
- The new `wo_source` value `'inspection'` needs the enum, the TS union, and the
  E2E project migrated in lockstep or `check-type-drift` fails looking like a
  types problem.
- Every platform-wide read paginates via `fetchAllRows()` — `max_rows = 1000`
  truncates silently.
- Photos go to a private bucket via `orgScopedStoragePath()`; `getPublicUrl()`
  on a private bucket is a semgrep chokepoint failure.
