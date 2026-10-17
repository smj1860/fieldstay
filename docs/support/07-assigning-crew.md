# Assigning Crew to Turnovers

**Crew assignment connects your cleaning and prep team to each turnover — once assigned, crew members see their work in the mobile app and can start checking off tasks.**

---

## How Assignment Works

When FieldStay creates a turnover from a booking (OwnerRez, Hospitable, Hostex, or Hostaway), it starts in **Pending Assignment** status with no crew assigned. What happens next depends on your org's Crew Auto-Assignment setting (Settings → Crew Auto-Assignment): **Suggest** scores every available crew member on proximity, reliability, workload, and past familiarity with the property and shows the best match right on the turnover card for a one-click assign; **Autopilot** assigns that best match automatically; **Off** leaves it fully manual.

Scoring looks at how many turnovers a crew member already has **on that specific date**, not just across the next fortnight. Three jobs stacked on one Tuesday and three spread across two weeks used to score the same; they no longer do.

---

## Assigning a Single Turnover

1. On the turnover card, click **Assign** (or **+ Add** if someone's already assigned)
2. Pick a crew member from the list that appears

The assignment happens immediately when you click a name — there's no separate save step. The crew member receives a notification immediately (if they have notifications enabled) and the turnover appears in their app.

---

## Bulk Assignment

To assign the same crew member to multiple turnovers at once:

1. Check the boxes on multiple turnover cards
2. In the action bar that appears at the bottom, use the **Assign to:** dropdown and choose a crew member

The assignment applies as soon as you pick a name — there's no separate Apply step. This is useful after a PMS sync that generates a batch of new turnovers.

---

## Limiting How Many Turnovers Someone Gets in a Day

Each crew member can carry a **Max/day** limit, set beside the Auto-assign toggle when you edit them in Manage Crew. Leave it blank and there is no limit, which is how every crew member starts.

When a limit is set, FieldStay will not auto-assign or suggest that person for a date they have already filled. This is a hard stop rather than a scoring nudge: a close, familiar crew member would otherwise still win on score while over their limit, and on Autopilot nobody is reviewing the result.

It governs only what FieldStay proposes. You can always assign someone by hand past their limit.

If every eligible crew member is at their limit for a date, the turnover stays unassigned and you get an alert saying so, naming the limit as the reason. That is the trade: a limit you set can leave work unassigned, and FieldStay tells you rather than quietly ignoring the limit.

---

## Crew Auto-Assignment

FieldStay doesn't use a fixed default crew member per property — assignment suggestions are computed per turnover, not configured per property. See **How Assignment Works** above for the three modes, or go to Settings → Crew Auto-Assignment to change yours.

---

## What the Crew Member Sees

Once assigned, the turnover appears in the crew member's app under Today's Turnovers or Upcoming Turnovers depending on the date. Tapping it shows:

- Property name and address
- Check-in and checkout times, or a planned start time once you have published that day's plan (see [The Crew Day Plan](./38-crew-day-plan.md))
- The full cleaning checklist
- Inventory count section
- Mark Complete button

Work orders assigned to crew look different: they carry **Start Work** and **Mark Work Complete** instead of a checklist. Crew have those two steps only. The detailed progress list (parts ordered, waiting on access, and so on) is a vendor feature, so an in-house job shows as In Progress rather than naming a reason.

---

## Assigning More Than One Crew Member

You can assign multiple crew members to the same turnover (click **+ Add** again after the first assignment) — useful when a property is large enough that crew split up and work different areas at once. Everyone assigned has full access to the same checklist and inventory section, and any of them can check off any item.

One thing to know: **Start Turnover** and **Mark Complete** act on the turnover as a whole, not per crew member — the turnover has one shared status. Whoever taps Start first moves it to In Progress for the whole team, and the button then disappears from the other assignees' screens. That's expected, not a glitch — see the FAQ entry ["Two crew members are assigned to the same turnover — why did only one of them see the Start Turnover button work?"](./19-faq.md) for the full explanation.

---

## When Crew Say They Are Running Late

A crew member's turnover screen carries one button: **I am running late**. One tap sends you a notification naming the property, and the button then reads "Your manager has been told" so nobody taps it twice.

It works offline. The tap is queued on the device like a checklist tick and sent when signal returns, keeping the time it was actually raised rather than the time it arrived, so a flag raised at 10am in a basement still reads 10am when it reaches you at noon.

This is the counterpart to the automatic running-late alert in [Notifications](./32-notifications-and-digests.md). That one works out that a job is behind from the checklist; this one is the person saying so, usually earlier, and for reasons no checklist can see: traffic, a guest who has not left, a key that is not where it should be.

You get one notification per turnover. A second tap changes nothing.

---

## Who Else Is On This Job

When more than one crew member is assigned to a turnover, each of their cards now names the others: **With Dana, Sam**.

The card showed nobody before, which made a shared turnover look identical to a solo one. That matters because a turnover has a single shared status, so a cleaner arriving to find the kitchen already done had no way to tell whether that was expected. Crew see names only, and only for turnovers they are assigned to themselves.

---

## Crew Work Orders

Separate from turnovers, you can assign a crew member to a **work order** — a specific maintenance or repair task at a property. Work orders assigned to crew appear in the crew app alongside turnovers but have a distinct amber card style and show the work order title rather than a cleaning checklist.

To assign a crew work order, go to **Maintenance → New Work Order**, fill in the details, and toggle to **Assign Crew** instead of **Assign Vendor**.

---

## Tracking Progress

The Turnovers Board updates in real time as crew members work through their checklist. The status moves from Assigned → In Progress when they tap Start, and → Complete when they tap Mark Complete. You receive a notification when the turnover is marked complete.

If a turnover runs past its own check-in with items still open and that crew member has another job later the same day, FieldStay raises a running-late alert naming how far the delay is projected to run into the next job. See **Running-Late Alerts** in [Notifications](./32-notifications-and-digests.md).

**A turnover also starts itself the moment the first checklist item is ticked.** Crew who open the checklist and get straight to work rarely remember to tap Start first, and before this the board showed nothing happening while the job was visibly underway. If you see a turnover go to In Progress without anyone tapping Start, that is why. The tick is the evidence. Either way, starting a turnover records the crew member's location as the visit check-in, so the phone has to be able to share it. If the crew member has location turned off, the turnover stays at Assigned until they allow it. See **Stay Evidence: Your Sealed Photo Record**.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
