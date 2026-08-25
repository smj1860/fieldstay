# Running an Inspection — Filling It Out, Failures, and What Happens After

This covers the walk itself: how the form behaves at the property, what a failed item turns into, and why a finished inspection can't be edited. For *when* inspections are due, see *Inspection Schedules*.

---

## Starting a walk

Go to **Maintenance → Inspections**. Anything due shows in a list with a Start button; you can also start one ad-hoc for any property without waiting for a schedule.

The clock starts when you tap Start — not when the inspection was scheduled, and not when a background job noticed it was due. That start time appears on the finished report, so it records a person arriving at the property.

---

## It works without signal

Inspections are built for basements, crawl spaces, and properties with no bars of service.

Once you've loaded the Inspections page at least once while online, the forms and your property list are held on the device. From then on you can start a walk, answer every item, take photos, and complete it with no connection at all. Everything queues locally and uploads when you're back in range.

Two things to know:

- **Load the page once while online first.** A device that has never been online long enough to hold the forms can't start a walk. You'll see a message saying so rather than a broken form.
- **Don't clear the browser data for the site mid-walk.** The queued answers live there until they upload.

If something fails to upload, a banner appears with a retry — queued work is never silently thrown away.

---

## Answering items

Most items are **Pass / Fail / N-A**. Some ask for a number, a date, a photo, or free text instead — a fire extinguisher count, an expiration date, a tag photo — and those show the right control rather than a Pass/Fail choice.

**N/A is a real answer, not a skip.** It means the item doesn't apply — no pool, no well pump. It isn't counted as a pass, and the owner-facing summary counts passes rather than "everything that didn't fail", so marking things N/A never inflates the result.

Some items only appear when they're relevant:

- **Asset-gated sections.** The well section only appears if the property has a well pump on its asset list. No pool, no pool questions.
- **Per-unit items.** A property with two dryers gets asked about both, one row each, rather than one question standing in for both.
- **Follow-ups.** A failure often opens a short follow-up — "which room?", "which detectors are expired?" — because that detail is what makes the resulting work order actionable.

### A description is required on a failure

A failed item needs a description, and where the item requires a photo, a photo or an honest reason there isn't one. That description becomes the title of the work order that gets created, so "handrail on the deck stairs is loose at the top bracket" produces a usable job and "broken" doesn't.

---

## What a failure turns into

When you complete the inspection, each failure becomes one of four things, decided by the item itself:

| Outcome | What happens | Example |
|---|---|---|
| **Work order** | A work order is created, ready to assign to crew or a vendor | Loose handrail, blocked dryer vent |
| **Purchase order** | Added to a purchase order for the property | Expired smoke detector, discharged extinguisher |
| **Notify** | Recorded and surfaced to you, but no job is created | Lapsed STR permit — that's a finance task, not a vendor's |
| **Record only** | Recorded as a fact, nothing raised | "Trampoline present", "no alarm system" |

You also pre-tick what kind of work it is — **Repair**, **Service**, or **Replace** — which travels with the work order.

**Cleaning is rolled up.** If several items on an Indoor walk need cleaning, they become **one** cleaning work order for the property rather than six, and FieldStay suggests the cleaner who last worked there.

**One purchase order per walk.** Three bulbs, an extinguisher and an HVAC filter is one order, not three.

---

## "This failed last time too"

If an item failed on a previous visit and the work order from it is still open, the form asks whether this is **the same problem** or **a new one**.

That question exists because FieldStay can't tell the difference and guessing either way is wrong. Quarterly inspections make repeat failures normal — and "Refrigeration" failing for a water filter in March and a compressor in June is the same item and two unrelated problems. Answering "same" attaches it to the existing work order; answering "new" raises a second one.

---

## Completing it

Sign off at the end. On completion, all at once:

- The failures become the work orders and purchase orders above
- The record posts to the **owner portal**, failures included, each showing the linked work order or purchase order and its current status
- The schedule advances to its next occurrence
- The inspection becomes **read-only**

### Why you can't edit a completed inspection

A completed inspection is locked at the database level — not by the interface being cautious, but by a rule the backend itself can't talk its way around.

The whole value of the record is that it wasn't adjusted afterward. An inspection history that can be edited later proves only what somebody was willing to write down today, which is worth very little to an insurer, an owner, or you in a dispute.

**If you need to correct something**, run a new inspection of the same form at that property. Both stay in the history — the original finding and the re-check, in date order — which is a stronger record than an edit, not a weaker one. The later walk supersedes the earlier one in practice; it doesn't erase it.

---

## Common questions

**Can I start an inspection that isn't scheduled?**
Yes. Start one for any property at any time — it's recorded the same way and appears in the same history.

**What if I have to stop halfway?**
Leave it. An in-progress inspection stays on the device and in your list until you finish it, and nothing about it is posted to the owner or turned into work orders until you complete it.

**Can two people work on the same inspection at once?**
It isn't designed for that. One walk, one person, one device — the answers live on that device until sign-off.

**Do owners see inspections that are scheduled but not done?**
No. Only completed ones post to the owner portal. An unfinished form isn't a record.

**Do owners see every failed item?**
They see the ones that produced work — the repair, the purchase, the noted issue — each with its current status. Purely factual items ("no alarm system present") aren't shown as findings, because they aren't problems.

**Can I delete an inspection?**
No, and completed inspections are also excluded from routine data retention cleanup. The record is the point.

**What happens to a failed item's work order if I complete it later?**
Nothing special — it's an ordinary work order from that point on. When it's completed, the cost posts to the owner's ledger like any other maintenance expense, and the owner portal's inspection entry updates to show it resolved.
