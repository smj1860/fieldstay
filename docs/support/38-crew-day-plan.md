# The Crew Day Plan — Planned Start Times

**FieldStay can work out what time each crew member should start each job, in order, and send that to their phone. Crew see nothing until you publish the day, so a planned time is always one a human looked at first.**

---

## The Problem It Solves

Before the day plan, a crew member's card showed the **checkout time** and nothing else. That reads as "be there at 10am" when what it actually means is "the property is free from 10am."

With one job in a day, that works out. With three, two of those three readings are wrong and the third is luck: the second job cannot start when the guest leaves, because the cleaner is still at the first one and then has to drive.

The day plan replaces the guess with a sequence: a start time per job that already accounts for the job before it.

---

## Where the Plan Comes From

FieldStay computes the plan overnight, so the coming day's times are ready before anyone starts work. Any change to who is assigned re-plans that date straight away, including a change you make at 9am for that same morning. A plan computed at 2am is wrong the moment you reassign someone.

For each crew member, each job starts at the **later** of two constraints, and both of them bind:

- when the property becomes free (the guest's checkout)
- when that crew member can physically get there, finishing the previous job and driving over, plus 10 minutes to park, unload, and find the lockbox

The drive between two stops is a **real routed driving time** wherever FieldStay has been able to look it up, not a straight line on the map. Routes are looked up once per pair of properties and reused, since a crew member's week is mostly the same pairs, and refreshed about four times a year. Where a route is not available the plan falls back to a straight-line estimate, which is always shorter than the road.

Jobs are sequenced earliest-free-first. This is deliberately not a route optimizer. A route that saves eleven minutes by visiting the far property second is worthless if it puts a cleaner at a door before the guest has gone, and an order you did not expect is one you cannot sanity-check at 7am.

How long each job takes is estimated from the property's bedroom count and that crew member's **own** rolling 90-day average minutes per bedroom. A crew member with fewer than three completed turnovers in that window has no average yet, so the plan uses your org's median rather than skipping them.

---

## Publishing the Day

The **Day plan** bar sits at the top of the Turnovers board. Pick a date and it tells you where that day stands, for example "12 planned, 0 published."

- **Publish to crew** sends that day's planned times to every assigned crew member's phone.
- **Withdraw** takes them back off. Crew fall back to the card they had before the plan existed, not to a stale time.

Nothing is sent automatically. A start time is an obligation, and one shown to a crew member with no human in between would make them "behind" against a number nobody agreed to.

On the board itself, each assignee's planned time appears under the turnover with a **Published** or **Draft** badge. Draft means you are the only person who can see it.

If you press Publish and get "Nothing to publish for that day," that date has no planned times yet, which normally means no crew are assigned to it.

---

## What Crew See

Once a day is published, the turnover card leads with the start time and demotes checkout to the constraint it really is:

> **Start 10:40** · Free from 10:00

Until you publish, the card is exactly what it has always been: the checkout time alone. An unpublished plan never reaches the device at all, so there is no way for a crew member to see a draft.

---

## What the Plan Does Not Change

- **Late is still measured against the guest, not the plan.** A turnover counts as late when it is completed after the guest's check-in time. A planned start never becomes a second, softer definition of late, and missing a planned start does not affect anyone's reliability score.
- **Manual assignment is untouched.** The plan describes the day you have arranged; it does not decide who gets what.
- **Properties with no coordinates get no drive time.** A drive needs both ends on the map. Where one is missing, the plan counts that leg as zero rather than inventing a number, so those days can be tighter in practice than they look. The fix is to give the property an address that geocodes, under Properties.
- **The commute is not part of a start time.** Home to the first job is real driving, and it appears in the day's total travel time, but it does not move the first start: a crew member can leave home as early as they need to, so the only thing holding up job one is the guest leaving.

---

## Travel Time on the Boards

Two places show driving time, and both now count the same things:

- **Crew Travel Today**, in the Ops snapshot, is per crew member and includes the commute at both ends of the day plus every work order they have, not only their turnovers.
- **Total Travel Time**, at the top of a crew member's own list, is the same figure for their day.

Where part of a day cannot be measured, both read **"at least"** before the number. That is deliberate: a day with one unmappable property used to show "Travel time unavailable" and nothing else, which told you less than the four legs it could already measure. The figure is a floor, never a guess.

A crew member's own app does not include their commute, only the driving between jobs. Their home address is not stored on their device.

---

## When a Day Starts Slipping

A plan is only a plan. For what happens when a job actually runs over and threatens the next one, see **Running-Late Alerts** in [Notifications](./32-notifications-and-digests.md).

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
