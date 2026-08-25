# Inspection Schedules — When They're Due and Why

Inspections are the one part of FieldStay where the *record* matters as much as the work. A single walk proves very little; several years of consistent ones is the artifact you can hand to an insurer or a permitting authority. That's why the scheduling behaves a little differently from scheduled maintenance, and this doc explains exactly how.

---

## The three inspection forms

| Form | What it covers | Typical cadence |
|---|---|---|
| Safety & Risk Mitigation | Detectors, extinguishers, egress, electrical and gas, water shut-offs, structure, pool and hot tub, permits | Once or twice a year |
| Indoor Property & Inventory | Room-by-room condition, appliances, furnishings | Quarterly is common |
| Outdoor Property & Grounds | Roof, siding, decks, grounds, well and septic where present | Quarterly is common |

Only the Safety form is scheduled for you automatically. Indoor and Outdoor are set up the same way as any other recurring maintenance — see *Templates, Checklists & Scheduled Maintenance*.

---

## How the Safety schedule gets created

During onboarding you answer two questions: **how often** the safety inspection should run (once or twice a year), and **which month** it starts in. That answer is a **template**, not a one-off setting — it describes how you want safety inspections scheduled, and FieldStay applies it to every property.

- **Once a year** — the schedule runs in the month you chose.
- **Twice a year** — the schedule runs in the month you chose and again six months later. Choose March and you get March and September; choose October and you get October and April.

Every active property gets its own schedule from that one answer. You don't schedule properties individually.

### Properties you add later

A property added after onboarding is picked up automatically and scheduled in the same month you originally chose. There's nothing to remember and nothing to repeat — a daily pass runs each morning, so a property added today is scheduled by the next morning at the latest.

### Changing the template later

Change the frequency or the start month in Settings and existing properties follow, with one deliberate exception: **a schedule that is already due or overdue keeps its date.** Somebody may be driving to that property today, and re-basing the date underneath them would either cancel a walk that was about to happen or re-open one that was just completed. Those schedules move to the new cadence after their next completed walk.

---

## Why the due date moves around

The first time a property is scheduled, its due date is the 1st of the month you chose. After the first completed inspection, the date starts landing on a **day when the property is empty**.

FieldStay looks at the gaps between bookings in the target month and picks a due date inside one. That's why two properties on the same schedule can be due on different days of the same month — they have different calendars. It's also why the date can move *earlier* as well as later between cycles.

If a property has no vacant day in that month, the schedule keeps its date and shows as due anyway. Nothing is skipped.

---

## Due, overdue, and what happens next

A due inspection **notifies you — it does not create anything.** There's no half-finished inspection sitting in your list waiting for someone to open it. The inspection record is created the moment somebody actually taps Start, which is what makes the start time on the finished report a real one: it records a person arriving at the property, not a background job running at 8am. That timestamp appears on the report, so it needs to be true.

You'll see a due or overdue inspection in three places:

1. **The dashboard** — an Upcoming Inspections section appears once anything is due within 30 days. Overdue rows are styled as overdue from the first day.
2. **Maintenance → Inspections** — the working list, with a Start button on each due schedule.
3. **The monthly overdue email** — see below.

---

## The monthly overdue email

On the **1st of each month**, FieldStay emails the account's Owner/Admin a single summary of every inspection that was due in a previous month and hasn't been walked yet.

**Why monthly, rather than the moment something goes late.** Inspection due dates cluster by month — a whole portfolio is scheduled in the same month, on days that vary by property because of the vacancy rule above. An email three days after each due date would mean a trickle of separate emails all month long. One email on the 1st, covering the month just ended, is one thing to read instead of twenty.

**It repeats.** Anything still outstanding appears in the next month's email too, and the month after, until it's done. The email doesn't go quiet while the problem is still there.

**One email per account, not per property.** It lists everything overdue, so a portfolio produces one message rather than one per house.

The trade-off worth knowing: an inspection missed early in a month isn't emailed about until the 1st of the next month. The dashboard shows it as overdue from day one, so the email is the escalation rather than the first you hear of it.

---

## Common questions

**Can I schedule an inspection for a single property on its own date?**
Yes. The template creates the schedules, but each one is an ordinary maintenance schedule afterward — open it in Maintenance and change its date or frequency without affecting anything else.

**What happens if I complete an inspection late?**
The schedule advances from the date it was due, not the date you walked it, so a late inspection doesn't permanently shift the cycle. The next due date is then adjusted to a vacant day as usual.

**Does an overdue inspection block anything?**
No. Nothing is locked, and no work is prevented. It shows on the dashboard, appears in the monthly email, and leaves a gap in the property's inspection history.

**Who gets the overdue email?**
The account's Owner/Admin. Inspection schedules aren't assigned to a specific person by default — FieldStay doesn't guess who should walk a property — so the email goes to whoever runs the account.

**Do inspections show up in the owner portal?**
Completed ones do, on the day they're finished, including anything that failed and the work order or purchase order it produced. Scheduled and in-progress inspections don't — an unfinished form isn't a record.

**I archived a property. Will it still be scheduled?**
No. Archived properties are skipped when schedules are created, and an archived property won't appear in the overdue email.
