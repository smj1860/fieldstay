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
inspection_templates            org-level form definition
  id, org_id, name, kind, description,
  platform_template_id (nullable),   -- seeded-then-editable, like org_inventory_catalog
  default_frequency, is_active

inspection_template_sections    grouping within a form
  id, template_id, name, sort_order

inspection_template_items       ONE question
  id, section_id, prompt, sort_order,
  is_required, photo_required,
  asset_type          (nullable) -- links the answer to a property_assets row
  remediation         'none' | 'work_order' | 'purchase_order'
  wo_category         (nullable) -- default for a generated WO
  wo_priority         (nullable)
  po_catalog_item_id  (nullable) -- default line item for a generated PO
  po_default_qty      (nullable)

inspections                     ONE performance of a form, per property
  id, org_id, property_id,
  template_id, template_snapshot jsonb,   -- snapshot: the form as it was THEN
  assigned_to_user_id,
  scheduled_for date, started_at, completed_at, completed_by_user_id,
  source_schedule_id (nullable)           -- which schedule generated it

inspection_items                ONE answer
  id, inspection_id, org_id,
  template_item_id, prompt_snapshot,
  result 'pass' | 'fail' | 'na',
  note, photo_path,
  asset_id (nullable),
  answered_at
```

`template_snapshot` matters for the same reason `checklist_instances` has one:
editing a template must not retroactively change what a completed inspection
says it asked.

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

---

## 7. Scheduling

Reuse `maintenance_schedules` with a discriminator:

```
creates               'work_order' | 'inspection'    (default 'work_order')
inspection_template_id (nullable)
assigned_to_user_id    (nullable)
```

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
- **Templates Hub** — the three forms live at `/templates`, following the
  seeded-then-editable pattern already used by `inventory_catalog` →
  `org_inventory_catalog`.

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
| 2 | The three forms | Platform-seeded, org-editable, in the Templates Hub |
| 3 | Fill + complete | Tablet UI, scoped SW, draft store, photos |
| 4 | Remediation | fail → WO/PO with partial-unique idempotency |
| 5 | Scheduling | `maintenance_schedules` discriminator |
| 6 | Surfacing | 30-day dashboard section, overdue email, owner portal |
| 7 | Export | History PDF via `pdf-lib`, copying the CPA export |

1–4 are the feature. 5–7 are what make it automatic.

---

## 11. Open questions

1. **Frequency defaults** per form — safety quarterly? whole-home annually?
   outdoor twice yearly on a season window?
2. **Photo policy** — required on every fail, or only where the template says so?
   Required-on-fail is stronger evidence but slower to complete.
3. **Partial completion** — can an inspection be saved and resumed across days,
   or must it complete in one visit? Affects how long a draft must survive.
4. **N/A handling** — does an N-A item need a reason? For insurance credibility
   "N/A — no pool at this property" is stronger than a bare skip.
5. **Multi-property** — can one scheduled inspection cover several properties,
   or strictly one each? Spec assumes one each.

---

## 12. Draft forms — FIRST PASS, needs correction

Drafted from the 21 `asset_type` values and standard practice. **Which items
are worth a PM's time, and whether a failure warrants a work order or a purchase
order, is operational judgment — please mark these up.**

`WO` = work order on fail · `PO` = purchase order on fail · `—` = record only
Asset column links the answer to a `property_assets` row.

### 12.1 Standard Safety Inspection — suggest quarterly

| # | Item | Fail | Asset |
|---|---|---|---|
| 1 | Smoke detectors present and sounding in every required location | WO | — |
| 2 | Smoke/CO detector batteries tested and within date | PO | — |
| 3 | CO detectors present and operational | WO | `CO/CO2 Detectors` |
| 4 | Fire extinguisher present, gauge in green, tag within date | PO | — |
| 5 | Exit routes and egress windows unobstructed | WO | — |
| 6 | Exterior and pathway lighting operational | WO | — |
| 7 | Handrails secure on all stairs, interior and exterior | WO | — |
| 8 | Deck/balcony structure sound — no soft, rotted or loose boards | WO | `deck_structure` |
| 9 | GFCI outlets test and reset — kitchen, baths, exterior | WO | `electrical_panel` |
| 10 | Electrical panel accessible, labelled, no scorching or corrosion | WO | `electrical_panel` |
| 11 | Water heater — no leaks, TPR valve clear, strapped if required | WO | `water_heater` |
| 12 | HVAC filter clean or replaced | PO | `hvac` |
| 13 | No visible mould or water intrusion | WO | — |
| 14 | All entry door locks and smart locks function | WO | `smart_lock` |
| 15 | Window locks function on ground-floor and accessible windows | WO | — |
| 16 | Pool/hot tub — gate self-latches, signage posted, no exposed wiring | WO | `hot_tub` |
| 17 | First aid kit present and stocked | PO | — |
| 18 | Emergency contact and address info posted and current | — | — |
| 19 | Grill — no gas leak, hoses intact, clear of structure | WO | — |
| 20 | Dryer vent clear of lint, exterior flap operates | WO | `dryer` |

### 12.2 Whole-Home Property Audit — suggest annually

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

### 12.3 Outdoor Property Audit — suggest twice yearly, pre-season on a month window

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
