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
| Offline scope | **Inspections only.** Nothing else in the dashboard goes offline. |
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
  remediation         'none' | 'work_order' | 'purchase_order'
  wo_category         (nullable) -- default for a generated WO
  wo_priority         (nullable)
  po_catalog_item_id  (nullable) -- default line item for a generated PO
  po_default_qty      (nullable)

inspections                     ONE performance of a form, per property
  id, org_id, property_id,
  form_id, form_snapshot jsonb,           -- snapshot: the form as it was THEN
  assigned_to_user_id,
  scheduled_for date, started_at, completed_at, completed_by_user_id,
  source_schedule_id (nullable)           -- which schedule generated it

inspection_items                ONE answer
  id, inspection_id, org_id,
  form_item_id, prompt_snapshot,
  result 'pass' | 'fail' | 'na',
  note, photo_path,
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


**The dashboard PWA has no service worker today.** `app/(dashboard)/layout.tsx`
links `dashboard-manifest.json` so it is installable, but only
`app/crew/crew-shell.tsx` and the work-order token page call
`register('/sw.js')`. "Inspections only" is true right now by default. The job
is to preserve it.

**Do not register the existing `/sw.js` on the dashboard.** Its navigate
handler caches every page returning 200, with no path scoping:

```js
if (response.ok && !response.redirected) cache.put(request, copy)
```

Registered dashboard-wide, every page a PM visits becomes offline-capable — so
a PM at a property with no signal opens `/ops` and gets yesterday's turnover
board rendered as current. Silent staleness, arriving as a side effect of a
feature that never asked for it.

**Instead:** a separate `/inspections-sw.js` registered with
`{ scope: '/inspections/' }`. Narrower than its own location, so permitted, and
the most-specific registration wins if crew's root-scoped worker is also on the
device. Everything outside that path stays uncontrolled and fails visibly
offline.

### Draft store

Self-contained, outside `lib/dexie/*`. No outbox, no cursors, no
reconciliation — an inspection commits atomically, so none of that machinery
applies.

- Answers and photo blobs held locally, keyed by inspection id.
- Survives reload and app restart.
- Submitted as **one** atomic completion.
- Photos upload opportunistically when online; otherwise held locally and
  flushed at submit.

### iOS risk, stated rather than buried

Safari can evict storage from installed PWAs under pressure. The UI must show
clearly and continuously when work is **held on this device** versus
**submitted**, and the draft must be genuinely durable. This is the single
biggest technical risk in the feature and the thing most likely to force a
rethink after real-hardware testing.

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
Maintenance page offline or nothing at all. §8's "scoped SW, inspections only"
decision is what forces a path here.

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
| 3 | Fill + complete | Tablet UI at `/maintenance/inspections`, SW scoped to that path, draft store, photos |
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

1. **WO or PO, per item.** "A No creates a work order or a purchase order" needs
   a side picked for every item. Some are obvious (`missing smoke detector` →
   PO to buy, WO to fit — arguably both). Some are not: an expired fire
   extinguisher is a PO at one org and a service WO at another. **Mark each item
   `WO` / `PO` / `—` when you send the other two forms**, and say what an item
   that genuinely needs both should do — my suggestion is PO, with the WO
   created when the part arrives, so nobody is dispatched to install something
   that is not there yet.

2. **The photo-on-fail escape hatch.** Required-on-fail plus a dead camera, a
   full tablet, or a photo that will not save offline equals an inspector who
   cannot submit at all. An unenforceable rule gets worked around; an explicit
   "photo unavailable" with a mandatory typed reason gets *recorded*, and reads
   honestly on the report. Worth having, or too easy a door?

3. **Who counts as a "designated team member".** The decision is PM-or-designate
   and explicitly not crew, but `member_role` has no such role — it is
   `admin | manager | crew | viewer | owner`. Is a `manager` always eligible, or
   is eligibility per-person (a flag on `organization_members`)? This decides
   whether `assigned_to_user_id` needs a companion permission or just a filter.

4. **Inspector title.** The form header asks for "Inspector Name & Title".
   Everything else in that header — property, address, date, time, management
   company — we already know and should prefill and lock, because a field the
   inspector types is a field the inspector can get wrong, and locked
   provenance is worth more as evidence. Title is the exception: nothing in
   `profiles` or `organization_members` stores one. Add it to the profile, or
   ask once per inspection?

5. **What "Indoor" and "Outdoor" must not both contain.** Two of the three
   forms run on the same cadence over the same property. Anything appearing in
   both gets inspected twice and, on a No, generates two work orders for one
   fault — the repeat-visit dedup in §6 keys on `form_item_id`, so the same
   physical problem asked in two forms is two different keys and it will not
   catch it.

   Now that the forms are fixed and platform-authored, this stops being a
   runtime problem and becomes an **authoring** one, which is strictly easier:
   it is checkable once, by us, before the seed ships. A test asserting no two
   forms carry the same `asset_type` + prompt shape is a crude proxy; reading
   the two forms side by side is the real check. Worth doing when the other two
   land, not after.

6. **Versioning a fixed form.** `inspection_forms.version` is in the model
   because the forms will change — an item added, a prompt reworded. Two
   questions that only matter once the first change lands: does an inspection
   already in draft when a new version seeds keep the old form (it must — the
   inspector answered those questions), and does the owner-portal history show
   which version each past inspection used? The `form_snapshot` on the
   inspection already makes both answerable; what is undecided is whether the
   report *says so*, and for an insurance artifact I would argue it should.

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

### 12.2 Indoor Property Inspection — SUPERSEDED FIRST PASS, awaiting the real form

Quarterly or 2× a year, month(s) chosen by the PM. The table below predates
that decision and predates the form itself; it is kept only so the shape is
visible, and is replaced wholesale when the real one arrives.

| # | Item | Fail | Asset |
|---|---|---|---|
| 1 | Walls and ceilings — no damage, scuffs or needed touch-up | WO | — |
| 2 | Flooring condition acceptable in every room | WO | — |
| 3 | All doors open, close and latch properly | WO | — |
| 4 | Windows open, close and lock; screens intact | WO | — |
| 5 | No drips under sinks; toilets not running; drains flow freely | WO | `plumbing_system` |
| 6 | Water pressure adequate at all fixtures | WO | `well_pump` |
| 7 | Refrigerator operational, seals intact, ice maker working | WO | `refrigerator` |
| 8 | Range/oven, microwave and dishwasher operational | WO | `oven_range` |
| 9 | Washer and dryer operational, no leaks | WO | `washer` |
| 10 | HVAC heats and cools; thermostat reads accurately | WO | `hvac` |
| 11 | All light fixtures and bulbs working | PO | — |
| 12 | Furniture sound — nothing wobbling, torn or stained | WO | — |
| 13 | Mattresses unstained and unsagged; protectors in place | PO | — |
| 14 | Linen and towel counts meet par and are in good condition | PO | — |
| 15 | Cookware, dinnerware and flatware counts complete | PO | — |
| 16 | TVs, remotes and wifi all functioning | WO | — |
| 17 | Interior paint condition acceptable | WO | — |
| 18 | Caulk and grout intact in all baths | WO | — |
| 19 | Cabinet and drawer hardware secure | WO | — |
| 20 | No odours; general cleanliness meets standard | WO | — |

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
