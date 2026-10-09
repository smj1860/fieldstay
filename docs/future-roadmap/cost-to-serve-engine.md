# Operational review: the missing money layer

**Status:** Brainstorm / proposed. Not started. Written 2026-10-09 from the
perspective of a 55-property regional manager ("Lakeside & Haven Property
Group") conducting a deep operational review.

Every capability claim below was verified against HEAD rather than taken from
docs or marketing copy. Where a claim contradicts an existing doc, the live
code wins and the contradiction is noted.

---

## 0. The one-sentence finding

FieldStay has an unusually rich **operational telemetry** layer and no
**unit-economics** layer at all. It can tell a PM what is going to go wrong
tomorrow and which asset dies in year nine, but it cannot tell them what a
single turnover costs, which properties are underwater, or whether to hire a
third cleaner or buy the hours from a vendor.

Verified absences behind that sentence:

| Thing | Status in code |
|---|---|
| Crew pay rate / labor cost | **No column anywhere.** No `hourly_rate`, `pay_rate`, `labor_cost`, `crew_cost` in any table or type |
| Gross margin / cost-to-serve | **No concept.** No margin computation in `app/` or `lib/` |
| `properties.cleaning_cost` | Revenue only (the fee charged, `cleaning_cost_visible_to_owner`) |
| `work_orders.actual_cost` | Vendor spend, synced from `work_order_line_items` by trigger |
| Labor minutes | **Already captured** (`assignment_outcomes.duration_minutes`, GENERATED from checklist timestamps) and never priced |
| Reserve recommendation | `total_10yr / 120`, computed in the view layer, twice (`capital-planning/page.tsx:207-211`, `owner/[token]/page.tsx:352-355`). No balance, no contributions ledger, no funded-vs-target |
| Vendor price benchmarking | None. `nte_amount` is a hand-typed number per WO with no basis |
| `is_same_day_turnover` | **Never written in production.** Zero writes in `lib/` or `app/`; only the demo seeder mentions it |

So the inputs to a cost model are nearly all present and uncombined. The one
genuinely missing input is a labor rate.

---

## 1. Operational audit: the dual reality at 55 properties

### 1.1 Nobody knows what a turn costs, so every cleaning fee is a guess that ages badly

The cleaning fee is set once at property onboarding and then outlives every
assumption behind it. Actual labor varies far more than the fee does: crew
mix, a 5-bedroom with three bathrooms versus a nominal 5-bedroom, a 20-minute
drive versus 50, a same-day flip against a 4-hour window versus an overnight
gap.

FieldStay already measures the thing that moves: `crew_speed_baselines`
(rolling 90-day `avg_minutes_per_bedroom`, min 3 completions) and
`assignment_outcomes.duration_minutes` derived from real checklist
timestamps. That is the hard half of a cost model and it is used only to
produce a risk score.

The consequence is not a reporting gap, it is a pricing gap. A property whose
every assigned cleaner overruns baseline is not a crew problem, it is a
mispriced property, and there is currently no artifact anywhere in the system
that can tell those two apart.

### 1.2 Vendor invoices are adjudicated one at a time, from memory

At 55 properties a regional manager sees enough plumbing, HVAC and
landscaping line items for a real price distribution to exist. FieldStay
captures them in exactly the right shape already: `work_order_line_items`
carries `line_type` (labor/material/equipment/subcontractor/other),
`quantity`, `unit`, `unit_cost` and a GENERATED `line_total`.

Nothing reads that corpus back. `nte_amount` is typed by hand at WO creation
(`CreateWorkOrderModal.tsx:411-432`) with no reference to what the same scope
has historically cost. Enforcement is also asymmetric in a way that matters:
the completion path hard-blocks a vendor submitting over NTE
(`vendor-portal.tsx:225-253`), but the quote path only warns
(`vendor-portal.tsx:1264`). So the number is strict where the work is already
done and advisory where it could still be negotiated, which is backwards.

### 1.3 Turn-window compression is modelled as risk and never as capacity

`lib/turnovers/generator.ts:180-195` computes `window_minutes` from
checkout/checkin, falling back booking to property to `11:00`/`15:00`, and
synthesises a 4-hour window for standalone turnovers
(`DEFAULT_STANDALONE_WINDOW_HOURS`). `crewDurationScore(estimatedMinutesNeeded,
availableWindowMinutes)` in `lib/scoring/friction.ts` carries the heaviest
friction weight (0.50).

So the physics is already there. What is missing is the aggregate: how many
infeasible windows the portfolio holds next month, and whether that is a
staffing decision or a calendar decision. The Ops Director's actual question
is "do I hire," and that question has no surface.

Worse, `is_same_day_turnover` is read in four places and written in none. The
`same_day_premium_pct` markup (default 25.0) is fully wired through to the
owner ledger at `turnover-events.ts:465` and gated on a flag nothing sets.
Every same-day flip in production is billed as an ordinary turn. That is
direct, quantifiable revenue leakage, and it is also a tidy illustration of
the thesis: the money paths are the unfed ones.

---

## 2. What FieldStay already gets right

Worth stating plainly, because the proposal below is additive and depends on
all of it.

### For the Property Manager

**The offline layer is a real engineering commitment, not a checkbox.** Seven
Supabase-backed tables cached in Dexie, eight mutation kinds, the optimistic
local write and its outbox row committed in one IndexedDB transaction
(`writeAndQueue()`), a drain that stops on first failure to preserve ordering,
transport failures tracked on a separate `networkRetryCount` so a dead zone
does not burn the dead-letter budget, dead letters retained 30 days with a
crew-visible retry affordance, and a 45-day assignment horizon that is
asserted to exceed the dead-letter window. Competitors advertise "works
offline." This is what it costs to mean it.

**The vendor magic link genuinely has no login.** Token-gated portal, line
items, photos, a full quote loop with multi-vendor comparison, and Stripe
Express destination charges so the vendor is paid without onboarding into
anything. Compliance is enforced structurally: `hard_blocked` vendors are
excluded from candidate pools, so an expired COI blocks assignment before it
becomes a liability conversation.

### For the Operations Director

**Asset modelling is better than the category norm.** The health score uses a
Weibull survival curve (`exp(-(t/eta)^kappa)`, shared shape 2.5 with a
per-type fit cron) rather than straight-line decay, plus MACRS depreciation,
a CPA export, repair-vs-replace reasoning and a 10-year CapEx projection with
deferred-scenario modelling. That is a credible owner-retention narrative.

**The friction forecaster grades itself.** `apply_friction_grading()` scores
*every* turnover against reality, not just the flagged ones, and the
calibration view leads with recall specifically because a turnover predicted
'none' that ran late is false confidence given to a PM. Vendors almost never
measure their own false negatives. It also refuses to add an LLM or a traffic
vendor on purpose, keeping it auditable and free.

**Pricing answers the tier burnout directly.** One graduated price, $19
anchor, marginal rates to 150 properties. Crossing a property count no longer
jumps the bill.

---

## 3. Three concepts that do not exist in competitor tools

### Concept A: Cost-to-Serve Ledger and Make-vs-Buy Advisor

**Premise.** Add one input, a crew labor rate, and the entire unit-economics
layer falls out of telemetry FieldStay already collects. Post a cost row on
every completed turnover and work order the same way `owner_transactions`
already posts revenue, then roll up to margin per turn, per property, per
crew member and per job category. On top of that, compare in-house loaded
cost against the vendor price book for the same scope and emit a make-vs-buy
recommendation.

**Ground execution (PM view).** Nothing changes for the cleaner. Cost accrues
from `checklist_instance_items.completed_at` timestamps that already sync
through the Dexie outbox, so a turn completed in a dead zone is priced
correctly the moment the device reconnects. No new field input, no timer to
remember, no reason for a crew member to feel metered.

**High-level value (Ops Director view).** Answers the three questions nothing
currently answers: which properties are underwater at their current fee, what
a turn actually costs by crew member, and whether the next unit of capacity
should be hired or bought. Converts "we feel busy" into a breakeven number.

**Competitor gap.** Breezeway and Turno are task and marketplace layers and
hold no labor rate or vendor line items. Operto is access, IoT and noise.
Guesty and OwnerRez hold revenue and channel data but nothing from the
ground, so their P&L stops at the invoice. None of them hold per-crew
minutes-per-bedroom baselines, which is the input that makes the model work.

### Concept B: Portfolio Price Book and NTE Policy Engine

**Premise.** Mine the existing `work_order_line_items` corpus into a
per-category, per-unit price distribution scoped to the org. Use it to
propose NTE automatically instead of asking a PM to guess, to flag an
inbound quote line that deviates from the portfolio median, and to replace
per-WO manual approval with category policy (auto-authorize under the p50,
require review above it).

**Ground execution.** The vendor experience is unchanged, which is the
point: still a link, still no account. The PM sees a quote annotated against
their own history before approving.

**High-level value.** Attacks vendor billing leakage, which at 55 properties
is a larger line than most PMs believe, and removes a per-WO judgment call
from the daily queue.

**Competitor gap.** Nobody else holds the line items. Breezeway has no vendor
billing surface at all; PMS tools see a single invoice total, not a priced
scope. The benchmark is only possible for a system that already made vendors
itemize, which FieldStay did.

### Concept C: Owner Capital Escrow Ledger

**Premise.** Promote the reserve from a display calculation to an accounted
balance. Today both the PM page and the owner portal compute
`total_10yr / 120` inline. Replace that with a real per-property reserve
ledger: a target contribution, actual contributions recorded against
`owner_transactions`, a running balance, and a funded-versus-required gap per
asset.

**Ground execution.** Field evidence re-underwrites the reserve. A failed
inspection item or a repair line item on an asset moves its replacement date,
which moves the required contribution.

**High-level value.** The strongest owner-retention mechanism available,
because the switching cost sits with the *owner*, not the PM.

**Competitor gap.** No STR ops platform does reserve accounting; it is
borrowed from HOA and commercial property management, where it is standard.

**Honest caveat.** Holding owner funds is trust-accounting territory,
regulated per state. The ledger should track and recommend, never take
custody, and that boundary needs a real legal read before anything ships.

---

## 4. Selection and functional spec: Cost-to-Serve Ledger

**Concept A wins.** Reasoning:

- It needs one new input (a rate) against an existing telemetry base, so it
  is cheap relative to its leverage.
- It has no regulatory surface, unlike C.
- It subsumes B's price book as an input, since vendor cost is half of
  cost-to-serve. B ships as phase 3 rather than as a competing project.
- The moat is accumulated history that does not export: 12 months of per-crew
  speed baselines, per-property true cost, and a priced vendor corpus. A PM
  who sets owner pricing off this cannot leave without going blind on
  margin. Margin data is stickier than task data, because task data is
  replaceable next week and pricing history is not.

### 4.1 Trigger / event

| Trigger | Action |
|---|---|
| `turnover/completed` | Post a cost entry for that turnover |
| `work_order/completed` | Attribute vendor spend to property and category |
| Nightly cron, after `crew-score-recompute` | Roll up property / crew / category aggregates and refresh variance flags |
| Monthly, after `generateCapexProjections` | Portfolio margin statement |

The nightly ordering matters for the same reason `friction-grading` runs
after `crew-score-recompute`: `duration_minutes` and `was_late` are written
by that cron's claim step, so running earlier reads NULLs.

### 4.2 Data inputs

**New (the only genuinely missing piece):**
- `crew_members.cost_basis` — enum `hourly | per_turn | salaried`
- `crew_members.cost_rate numeric(10,2)`
- `crew_members.loaded_cost_multiplier numeric(4,2)` default 1.0, for
  payroll burden on W2 crew

**Existing, unpriced today:**
- `assignment_outcomes.duration_minutes` — actual labor minutes
- `crew_speed_baselines.avg_minutes_per_bedroom` + `sample_size` — expected
  minutes, for variance
- `work_order_line_items` — vendor cost and the price book
- `properties.cleaning_cost`, `same_day_premium_pct` — revenue per turn
- `turnovers.window_minutes`, `is_same_day_turnover` — premium eligibility
- `owner_transactions` — already-posted revenue and expense
- Inventory consumption (`record-consumption.ts`) — consumables per turn
- `pre_flight_friction.score_breakdown` — risk-adjusted cost attribution
- Haversine distance (`lib/scoring/geo.ts`) — drive cost, **modelled not
  measured**, see 4.5

### 4.3 Automated logic

**Per-turnover cost entry.** `labor = actual_minutes x cost_rate x
loaded_multiplier`, plus modelled drive cost, plus consumables, plus
attributed WO spend. Revenue is the cleaning fee plus the same-day premium
where eligible. Written to a new `turnover_cost_entries` table, idempotent on
`source_reference_id = turnover_id` against a UNIQUE index, reusing the
established `owner_transactions` dedup pattern.

**Three NULL rules, non-negotiable.** `duration_minutes` is GENERATED, capped
at 480, and NULL for anomalies. NULL means *not applicable* and must
contribute zero to any aggregate, never zero-as-a-value. A crew member under
3 completions has no baseline row and must fall back to the org median rather
than being skipped. A property with no `cleaning_cost` yields a cost entry
with a null margin, not a margin of negative cost. All three are the same
lesson `apply_crew_score_recompute()` already paid for.

**Variance attribution, the valuable half.** Group overruns by property and
by crew member independently. Every crew overruns at property X implies the
*fee* is wrong; one crew member overruns everywhere implies a *crew* issue.
Only per-crew baselines make this separable, which is why no competitor can
compute it.

**Make-vs-buy.** Per `wo_category`, compare in-house loaded cost at observed
duration against the vendor price book p50 for the same scope. Gate on a
minimum sample on both sides and return "insufficient history" rather than a
confident wrong answer.

**NTE proposal.** Default `nte_amount` to price-book p75 for the category and
scope, still PM-editable. Also fix the asymmetry: the quote path should warn
with the benchmark attached, since that is the only point where the number
can still change anything.

**Never auto-act on money.** Recommend only. This mirrors the deliberate
decision recorded in `auto-assign-vendor.ts:11-33`, where committing spend
without human review is the reason vendor autopilot is unshipped. A cost
engine that re-prices an owner contract by itself would be the same mistake
with larger consequences.

**Prerequisite fix.** Write `is_same_day_turnover` in
`lib/turnovers/generator.ts` where `window_minutes` is already computed. The
margin model is wrong on every flip until this lands, and the premium revenue
is being lost today regardless of this proposal.

### 4.4 Output / deliverable

**PM.** A margin column on the turnover board and a per-property Turn
Economics card: fee charged, true cost, margin percent, and where applicable
"this fee is $X below cost-to-serve, re-price to $Y." Actionable, one number,
no dashboard archaeology.

**Ops Director.** Portfolio margin table sortable by margin percent; crew
cost-per-turn leaderboard, which is deliberately cost per turn and not speed,
because the fastest cleaner is not always the cheapest; make-vs-buy table per
category; and a capacity model stating the breakeven, for example "landscaping
crosses in-house breakeven at 7 more properties."

**Owner.** Not the margin, ever. Exposing PM margin to an owner is a trust
hazard, not transparency. The existing `cleaning_cost_visible_to_owner` flag
is the right precedent: cost justification only where the PM opts in.

**Vendor.** The derived NTE, exactly as the portal shows it today. The
benchmark deviation stays PM-side. Handing a vendor your portfolio median
gives away the negotiating position the price book exists to create.

### 4.5 Known limits to state rather than hide

- **Drive cost is modelled, not measured.** Distance is straight-line
  haversine; there is no routing provider. The cost model must label drive
  cost as an estimate. Adding a traffic API should clear the same bar
  `lib/scoring/friction.ts` sets when it refuses one: a paid, maintained
  source or nothing. A cost figure that looks measured and is not is worse
  than an honest estimate.
- **Price book cold start.** A new org has no corpus. Gate every benchmark on
  a minimum sample and degrade to "no benchmark yet."
- **Pay rates are compensation data.** They need RLS from the first
  migration, exclusion from logs, and an addition to the
  `sensitive-data-logging` guardrail's banned-field list in the same PR, the
  same treatment `actual_cost` already gets.
- **Scale.** `turnover_cost_entries` grows with time, not portfolio size, so
  every read needs a window or a drain. The `-org-scoped` semgrep tier note
  applies directly: this is a table that grows with time, which is the unsafe
  kind.

### 4.6 Suggested phasing

1. Rate columns, cost entries on `turnover/completed`, per-property margin.
   Includes the `is_same_day_turnover` fix.
2. Variance attribution (property-mispriced versus crew-slow) and the PM
   re-price recommendation.
3. Price book from the existing line-item corpus; derived NTE; quote-path
   benchmark.
4. Make-vs-buy and the capacity/breakeven model.

Phase 1 alone is shippable and immediately useful, which is the test this
should be held to.
