# Work Orders & Crew Scheduling — Operational Analysis

**Date:** 2026-10-11
**Scope:** the work-order lifecycle and the crew/turnover scheduling engine, as they exist in code today
**Lenses:** PM company operations director · skilled-trades business operator · cleaning crew member

Every claim below is grounded in a file reference. Where something does not exist, I verified
its absence rather than inferring it.

---

## Part 0 — What the code actually does today

### Work order lifecycle

`wo_status` = `pending | quote_requested | assigned | in_progress | completed | cancelled`
(`types/database.ts:59`)

| Transition | Written by | Who can trigger it |
|---|---|---|
| → `pending` | `createWorkOrder` (`maintenance/actions.ts:510`) | PM, crew flag, inspection finding, maintenance schedule cron |
| → `quote_requested` | quote request flow | PM |
| → `assigned` | `dispatchWorkOrderToVendor` (`app/actions/work-order-public.ts:341`), `bulkAssignVendor` (`actions.ts:1199`), `acceptVendorSuggestion` (`actions.ts:1351`), `work-order-vendor-assigned.ts:147` | PM only |
| → `in_progress` | **`bulkUpdateWorkOrderStatus` only** (`actions.ts:1695`) | PM only, and only via the board's bulk "Set status…" dropdown (`maintenance-board.tsx:1626-1646`) |
| → `completed` | `workOrderCompletionFields()` + `finalizeWorkOrderCompletion()` | PM, vendor portal, crew PWA |
| → `cancelled` | `actions.ts:859` | PM |

**`in_progress` is effectively decorative.** The only way a work order reaches it is a PM
checking boxes on the maintenance board and picking it from a bulk dropdown. There is no
single-WO status control at all — the detail panel's actions are
`markVendorAcknowledged` / `markWorkVerified` / `cancel` and nothing else
(`components/work-orders/use-work-order-actions.ts`). Nobody who is physically doing the
work can move the status.

**The vendor's entire interaction surface is one button.** The dispatch email's CTA is
`'Submit Quote →'` or `'Mark as Complete →'` (`lib/resend/emails/work-order-vendor.tsx:101`).
The portal (`app/work-orders/[token]/vendor-portal.tsx`, 1,294 lines) lets a vendor save a
draft, attach up to 5 photos, enter line items and submit a completion. There is no accept,
no decline, no reschedule, no "on my way", no "parts on order".

**`vendor_acknowledged_at` exists but the vendor never writes it.**
`markVendorAcknowledged` is gated on `requireOrgRole(['admin','manager'])`
(`work-order-actions.ts:159-166`) — it is the PM recording, by hand, that someone answered
the phone.

**`public_viewed_at` is a dead column.** It is declared (`types/database.ts`) and nothing in
`app/`, `lib/` or `components/` ever writes it. "Did the vendor even open the link" is
currently unanswerable.

**Declining exists, but only in the PM's direction.** `quote_requests.status` includes
`'declined'` (`types/database.ts:88`) and `declineQuoteRequest` (`maintenance/actions.ts:764`)
is the PM rejecting a vendor's *price*. The vendor has no inverse.

**The only pressure valve is a 7-day timer.** `cron/work-order-ops.ts` escalates any open,
non-urgent WO whose `updated_at` is older than `AGING_DAYS = 7` to `urgent`
(`work-order-ops.ts:14, 272-321`). Because it keys on `updated_at`, any edit — a note, a
photo, a line item — resets the clock. There is no separate "dispatched and silent" timer.

**What is genuinely strong here:** compliance gating (a `hard_blocked` vendor cannot be
assigned, and an *unverifiable* vendor is treated as blocked rather than waved through —
`cron/work-order-ops.ts:34-48`); the quote/NTE flow with side-by-side comparison
(`components/work-orders/quote-comparison.tsx`) and an `approve_quote_request()` RPC that
copies quote lines straight onto the WO; the completion fan-out guardrail that makes an
owner P&L expense, `completed_date`, the update log and the schedule advance inseparable
from the status write (`unit/guardrails/work-order-completion-side-effects.test.ts`).

### Crew scheduling

**Drive time is not part of the assignment decision.** `lib/scoring/geo.ts` is 28 lines:
haversine great-circle distance from the crew member's **home** coordinates to the
property's, bucketed into five steps (`<5km → 1.0`, `<15 → 0.8`, `<30 → 0.6`, `<50 → 0.4`,
`<80 → 0.2`, else `0.0`). No roads, no traffic, no time of day, and the origin is always
home — never the stop they will actually be coming from.

Weights (`lib/scoring/crew-candidates.ts:56-57`):

| | proximity | reliability | capacity | workload | familiarity |
|---|---|---|---|---|---|
| Same-day flip | 0.40 | 0.30 | 0.15 | 0.10 | 0.05 |
| Standard | **0.15** | 0.25 | 0.10 | 0.20 | 0.30 |

On an ordinary day, geography is 15% of the decision and is measured from the wrong origin.

**Drive time *is* displayed — twice — as crow-flies ÷ 30 mph.** `app/crew/page.tsx:19,72-86`
(crew home screen, today's chain) and `app/(dashboard)/ops/ops-snapshot.tsx:20,415-444`
(PM, per crew member). Both chain consecutive stops sorted by `checkout_datetime`, both
exclude home→first and last→home, both exclude work orders from the chain entirely, both
return "unavailable" if any one property lacks coordinates, and `AVG_DRIVE_SPEED_MPH = 30`
is hardcoded separately in each file.

**There is no scheduled start time per turnover.** `turnovers` carries
`checkout_datetime`, `checkin_datetime`, `window_minutes`, `started_at` (the Start button
press) and `completed_at`. `turnover_assignments` carries `assigned_at` and `notified_at` —
no start time, no planned duration, no sequence number (`types/database.ts`). The time on a
crew member's card is the **checkout** time (`app/crew/page.tsx:126-128`), which reads like
"be there at 11:00" and actually means "the guest leaves at 11:00."

`window_minutes` is `checkin − checkout` for a real booking pair
(`lib/turnovers/generator.ts:219`); on a standalone turnover it is a placeholder
`DEFAULT_STANDALONE_WINDOW_HOURS` (4h), which the crew UI correctly hides so nobody is told
to hurry for nobody (`app/crew/page.tsx:130-133`). Priority is derived from the window:
`<120min → urgent`, `<240 → high`, `<480 → medium`, else `low` (`generator.ts:120-125`).

**A duration model already exists and is wired to nothing that schedules.**
`crew_speed_baselines` holds a rolling 90-day average minutes-per-bedroom per crew member
(minimum 3 completed turnovers, org-median fallback). Its only consumer is
`cron/pre-flight-friction.ts`, which multiplies it by bedroom count and compares it to the
window via `crewDurationScore()` (`lib/scoring/friction.ts:94-106`) — scoring overrun
linearly from 1.0× to 1.5×. That runs once at ~2am and paints a risk badge on `/ops`. It
never informs an assignment, never produces a start time, and never blocks anything.

**There is no capacity limit of any kind.** `capacity_score` is a 0-1 scoring *weight*, not a
cap — stated explicitly in `auto-assign-turnover.ts:44-56`: *"no such cap exists anywhere in
this product… nothing in the schema, the settings, or the UI defines a maximum number of
turnovers per crew per day."* And `workload` is a raw **count** of assignments across the
next 14 days flattened to `1 − count/max` (`lib/scoring/pools.ts:10-22`,
`crew-candidates.ts:124`), so three jobs stacked on one Tuesday and three spread over two
weeks score identically.

**Autopilot assigns exactly one person.** `crew_needed: 1` is hardcoded in the gap event and
the write is `[top.crew_member_id]` (`auto-assign-turnover.ts:296-340`). There is no notion
of how many cleaners a property needs.

**Availability is a whole-day boolean.** `crew_availability` is
`(crew_member_id, available_date, is_available, notes)` over a −30/+365 day window
(`app/crew/availability/window.ts`). It is a hard exclusion in autopilot — correctly, since
no human reviews the pick (`auto-assign-turnover.ts:146-160`). There are no time-of-day
windows, no recurring weekly pattern, no "mornings only."

**One turnover has one shared status for every assigned crew member.** Documented in the crew
FAQ itself (`app/crew/crew-shell.tsx:753`): the first assigned person to tap Start moves it to
In Progress for everyone, and the button then disappears from the others' screens.

**The PM has no intraday view.** The turnovers board offers list and Gantt
(`turnover-board.tsx:998`), and the Gantt is a property × **day** grid — `colW` per day,
3 days back, 18 ahead on desktop (`turnover-gantt.tsx:50-55`). Nothing in the product shows a
crew member's day on an hour axis.

**The cascade-detection seam is already built and deliberately unused.**
`lib/scoring/crew-day-context.ts` returns, per assigned crew member, their earlier turnovers
today with live checklist completion ratio and an `isRunningLate` flag — computed from
`checklist_instance_items.completed_at`, which updates item by item as a cleaner works. Its
own header says *"Nothing calls this yet, deliberately. The seam is the signature and the
return shape, not an integration."* It is the single highest-leverage unfinished thing in
either system.

---

## Part 1 — Operations director, property management company

*Managing 10–50 properties, 3–8 cleaners, 10–20 trade vendors. Judged on guest-ready-by-check-in,
cost per turn, and not being the bottleneck.*

### What breaks on a Saturday

Saturday is 70% of the week's turnovers in a four-hour window. Today the system hands me:
a list of turnovers each stamped with a checkout time, one cleaner auto-picked per turnover
by a formula that weights geography at 15% from the wrong origin, no plan for the order
anyone works in, no estimate of when anything finishes, and a crow-flies mileage total
computed in whatever order `checkout_datetime` happened to sort. Then I rebuild the day in my
head or in a group text.

The `/ops` friction panel knows at 2am that a cleaner is 1.4× over their window on three of
their five jobs. It tells me, in a badge, hours before any of it happens — and then the
assignment engine that caused it never reads that number.

### The six things I would ask for, in priority order

**1. A scheduled start time on the turnover, and a plan that produces it.**
Not a field a PM types. A `planned_start_at` / `planned_end_at` pair on
`turnover_assignments`, written by a day-planner that already has every input it needs:
`crew_speed_baselines` × `bedrooms` for duration, property coordinates for travel, the
`checkout_datetime`/`checkin_datetime` window for the hard constraints. Sequence the day,
stamp the times, show me the result, let me drag it. This is the single change that makes
everything else in this list possible, and the ingredients are all already in the database.

**2. A real capacity model, because right now there is none.**
`workload` as a 14-day count cannot see that Tuesday is triple-booked. I need
`max_turnovers_per_day` and/or `max_minutes_per_day` per crew member, enforced as a hard
constraint on autopilot the way `crew_availability` already is. The code comment is right
that this is a product decision rather than a scalability fix — so make it. The default can
be permissive; the point is that the number exists and the engine respects it.

**3. Cascade detection, promoted from stub to live.**
`getCrewDayContext()` is written, paginated, N+1-safe and tested. Wire it to a 30-minute
cron: if a crew member's current job is past its own check-in with an incomplete checklist and
they have N more today, tell me *now* — with the downstream jobs named, so I know whether to
reassign the 3pm or warn the guest. The deliberate choice to keep the decision out of a
formula is correct; the choice to never surface the signal is not.

**4. Vendor acceptance as a real state, not a phone call I log by hand.**
When I dispatch, I need to know within a defined window whether that vendor has the job.
Three states a *vendor* can write: accepted, declined-with-reason, accepted-but-needs-a-
different-date. Plus an auto-escalation when nobody answers — which today does not exist,
because the 7-day aging timer keys on `updated_at` and resets if I so much as add a note.
A dispatched work order can sit silent for a week before the system raises its voice, and
"silent for a week" on an HVAC call in July is a lost booking.

**5. Status that reflects reality without me typing it.**
`in_progress` reachable only from a bulk dropdown means my board is a lie the moment anyone
starts working. The vendor's "on my way"/"on site" and the crew's checklist first-tick should
both move it. The data for the crew side already flows —
`checklist_instance_items.completed_at` updates live, which is exactly what
`crew-day-context.ts` exploits.

**6. Fix the two drive-time displays or remove them.**
Crow-flies ÷ 30mph, excluding the commute at both ends, excluding every work order, with the
constant duplicated in two files and a silent zero when one property lacks coordinates. On a
lake or a mountain market that is not approximately right, it is wrong by a factor of two in
the direction that matters. Either route it properly or stop printing a number people will
plan around.

### Where I would spend nothing

The compliance vault and its hard-block. The quote comparison and NTE flow. The completion
fan-out to owner P&L. The friction forecaster's *scoring* (the problem is who reads it, not
what it computes). The deliberate refusal to put an LLM in the scorer — I do not want to
explain "why did the AI say 94%" to an owner.

---

## Part 2 — Skilled-trades business operator

*HVAC/plumbing shop. 4 techs, 60–80 calls a week across a dozen property managers, three
of whom use software I did not choose.*

### What this portal asks of me

A link arrives. It says one thing: Mark as Complete. That is a tool built on the assumption
that receiving the work order and agreeing to do the work are the same event. They are not,
and the gap between them is where my whole business lives.

### What is actually missing

**I cannot say no.** I have four techs. On a July Monday I am triaging a dozen calls and
some of them are not mine this week. There is no decline, no reason code, no "Thursday
instead." My options are: ignore the link and take the phone call later, or accept by
silence and disappoint someone. There is a `'declined'` status in the schema — it belongs to
the PM rejecting *my price*, not to me declining *their job*. The asymmetry tells you who the
tool was designed around.

**I cannot say "not today, but yes."** Most of what a PM reads as a decline is really a date
negotiation. One field — propose an alternate date — converts the majority of declines into
scheduled work, and today it does not exist. The work order already has `scheduled_date` and
`scheduled_time` columns (`types/database.ts:1063`, `CreateWorkOrderModal.tsx:422`) — the PM
can set an appointment time, I just cannot touch it.

**I cannot show progress, so I get chased.** No "on my way," no "on site," no "parts on
order, back Thursday." The only legible states are not-done and done. So the PM calls to ask,
and I take the call, and we both spend ten minutes recreating information the portal could
have held. For a multi-visit job — diagnose, order the compressor, return to install — there
is no way to represent the middle at all. I either leave it open and silent for two weeks
(and get auto-escalated to `urgent` at day 7 for the sin of waiting on a supplier) or I close
it and lose the thread.

**Nobody knows if I read it.** `public_viewed_at` is a column nothing writes. When a PM says
"I sent you three work orders," I cannot show that two never reached me, and they cannot see
it either. That is a trust problem with no technical obstacle in front of it.

**My tech cannot use it.** The token goes to one email address — mine. There is no way to
forward a job to the tech who will actually do it such that his photos and his notes land on
the record under his name. `completed_by_name` is free text typed at the end
(`work-orders/[token]/complete/route.ts:161`).

**The 7-day escalation punishes honesty.** Because it keys on `updated_at`, the vendor who
documents progress keeps resetting the clock while the vendor who does nothing also resets
it by touching anything. Aging should measure time since *dispatch* and time since *last
state change the vendor made*, not time since any row write.

### What I would keep

The quote flow is good — line items with type/quantity/unit cost, a real total, a token that
expires, a $1M ceiling and 100-line cap. The offline queue in the portal is genuinely better
than most of what I use: drafts survive, photos queue, dead letters explain themselves in
plain language (`vendor-portal.tsx:76-86`). The compliance vault nagging me about my COI
before it expires is annoying and correct. And getting paid through Stripe Connect off the
same record I completed is the reason I would tolerate the rest.

### If I could change one thing

Four buttons on that email instead of one: **Accept** · **Decline (reason)** · **Propose
another date** · **Submit quote**. Everything else is downstream of being able to answer.

---

## Part 3 — Cleaning crew member

*Four to six turnovers on a Saturday, my own car, phone-only, patchy signal at the lake
properties.*

### What the app tells me on Saturday morning

A list. Each card has a property name, an address, a status pill, and a time. Four cards.
Under them, one line: today's travel, 41.3 mi, 1:22.

### What it does not tell me

**When to be anywhere.** That time on the card is the guest's checkout. Every card says
10:00 or 11:00 because that is when guests leave. It is not when I should arrive and it is
not in the order I should work — but it is the only number on the card, so it is the number I
plan around. I sequence my own day by guessing. If I guess wrong I am at a property where the
guest has not left, or I am at the far end of the lake at 2pm with a 3pm job back at the
other end.

**How long anything should take.** The system knows. It knows my personal average
minutes-per-bedroom over the last 90 days, and it knows this is a 4-bedroom. It knows at 2am
that today's fourth job is 40% over its window. It shows me none of that. If I am behind, I
find out when a PM calls.

**That the drive number is a guess.** 41.3 miles ÷ 30 mph, straight lines, and it does not
count getting from home to the first job or home from the last. Around a lake, straight-line
distance and road distance are different by a factor of two. I will be 25 minutes late to
job three and it will look like I was slow at job two.

**Who else is on this job.** A turnover has one status for everyone assigned
(`crew-shell.tsx:753`). If I am the one who taps Start, it starts for both of us; if she
taps it first, my button disappears. The FAQ explains this well — but the card never says
"you and Maria," so I find out by the button vanishing.

### What I would ask for, in my order

1. **A start time on each job, and the jobs in the order I should do them.** One number per
   card: *be here at 11:30*. That is the whole ask. Everything else is secondary.
2. **An expected duration** — *about 2h 15m for you at this property* — so I can tell at
   10am whether the day works, instead of at 2pm.
3. **Real drive time between my stops, including from home.** Or no number at all. A wrong
   number I plan around is worse than no number.
4. **A way to say "I'm running late" that reaches the PM without a phone call.** Right now my
   options are: call, text, or let them find out.
5. **A way to say "I can't do Tuesday afternoon."** Time off is a whole-day toggle. My life
   is not whole days. Half-day blocks would cover nearly all of it.
6. **My name on the card when I'm sharing a job.**

### What is already good and should not be touched

Offline. It genuinely works — I tick items with no signal, the red "didn't sync" panel tells
me exactly what is stuck with a Retry All, and nothing has silently vanished. Spanish
throughout, not just the menus. Photos queue instead of failing. The checklist is the job,
not a form about the job. That foundation is why the missing pieces above are frustrating
rather than disqualifying: the hard part is built.

---

## Consolidated: what the three perspectives agree on

The three lenses disagree about priority but converge on the same two root causes.

**Root cause 1 — the system records time but never plans it.**
Turnovers have a window, not a schedule. Everything needed to produce a schedule already
exists and is already computed daily: per-crew speed baselines, property coordinates, the
hard window, the overrun score. The only missing pieces are a planner that sequences the day
and two columns to write the answer into. The operations director wants it for Saturday
triage, the cleaner wants it as one number on a card, and the vendor wants the same thing one
layer up (an appointment they can confirm or move). All three are the same build.

**Root cause 2 — the people doing the work cannot write state.**
`in_progress` is PM-bulk-only. Vendor acknowledgement is PM-proxied. Vendor decline does not
exist. `public_viewed_at` is never written. "Running late" has no channel. The result is that
every status in the system is a PM's transcription of a phone call, which is exactly the
cognitive overhead this product exists to remove.

### Suggested build order

| # | Change | Unblocks |
|---|---|---|
| 1 | `planned_start_at`/`planned_end_at` on `turnover_assignments` + a day-planner using existing baselines, coordinates and windows | Crew start times, PM Saturday view, duration display, late detection |
| 2 | Vendor response states — accept / decline-with-reason / propose-date — written by the vendor, plus a dispatch-silence timer independent of `updated_at` | Vendor capacity management, PM escalation, no more phone transcription |
| 3 | Promote `getCrewDayContext()` from stub to a live cascade alert | Same-day intervention before the guest is affected |
| 4 | Per-crew daily capacity as a hard autopilot constraint, and workload measured per day rather than per fortnight | Autopilot that cannot triple-book Tuesday |
| 5 | Progression states writable by whoever is working — crew first checklist tick → `in_progress`, vendor on-site/parts-on-order | Boards that are true without typing |
| 6 | Real routed travel time, one shared implementation, including home legs — or remove both displays | Trustworthy numbers people plan around |
| 7 | Half-day availability; crew "running late" signal; co-assignee names on crew cards | Crew quality-of-life, fewer phone calls |

### One incidental defect found while reading

`crewSuggestionReasoning()` (`lib/scoring/crew-candidates.ts:181`) builds
`` `${top.name} — ${reasons.join(', ')}` `` with an em dash. That string is written to
`turnovers.suggestion_reasoning` and rendered to the PM at
`app/(dashboard)/turnovers/turnover-board.tsx:504`, which makes it customer-facing copy under
CLAUDE.md's styling rule. It passes CI because `unit/guardrails/customer-facing-em-dashes.test.ts`
scopes its scan to `app`, `components`, `emails`, `lib/resend`, `lib/sms`, `lib/crew`,
`lib/guidebook` and `lib/inspections/forms` — `lib/scoring` is not in `SCOPED_DIRS`
(`customer-facing-em-dashes.test.ts:59-68`). The same blind spot covers
`pre_flight_friction.smart_fix_reasoning`, which that function also feeds.
