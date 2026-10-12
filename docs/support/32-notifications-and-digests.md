# Notifications — The Bell, and the Daily Wrap-Up Email

FieldStay surfaces what needs your attention in two places: a live notification bell in the dashboard, and a daily wrap-up email in the evening. This doc explains what triggers each one and how to read them.

---

## The Notification Bell

The bell icon in the dashboard header shows two kinds of items mixed together:

**Live alerts** — things that are true right now, and disappear on their own once resolved:
- Unassigned or flagged turnovers checking out today or later
- Urgent-priority work orders that are still open
- Inventory items counted below par level
- Vendors in a compliance grace period or hard-blocked

These aren't "read" or "dismissed" individually — assign the turnover, resolve the work order, restock the item, or fix the vendor's compliance document, and the alert clears itself because the underlying condition is no longer true.

**Event notifications** — one-time things that already happened, or a heads-up about something coming up (a work order was completed, a vendor was dispatched, an asset's warranty is expiring within 30 days, etc.). These stay in the list until you open them, at which point they're marked read. Unlike the live alerts above, these don't resolve themselves — they're a log of what occurred, not a condition that clears on its own.

Each notification links directly to the relevant turnover, work order, or page — click it to go straight there.

---

## Running-Late Alerts (The Cascade Check)

Every 30 minutes, FieldStay looks for a turnover that is **past its own check-in time with work still left on the checklist**, where that same crew member has **another job later the same day**. When it finds one, you get a bell notification.

The late turnover itself is already visible on the board. What is not visible is that it is about to make the next one late too, and that is the only thing this alert is for.

The notification names the crew member, how far past check-in they are, and how far the delay is projected to run into their next job, for example:

> **Juniper Cottage is running late**
> Dana is 45 min past check-in, projected 30 min into Lake House.

That projected figure is remaining work plus drive time plus the arrival buffer. Remaining work comes from the live checklist: how many items are ticked off right now, not an estimate of how it is going. If several turnovers are running late at once, they are listed worst-projected-overrun first, so the top one is the one to deal with.

Three things worth knowing:

- **You get told once per turnover per day, not every 30 minutes.** The first check that sees a job slip notifies you, and the rest of that day's checks stay quiet. Being told early is the value; a job that is 30 minutes late at noon and four hours late at 4pm does not need nine reminders in between.
- **FieldStay does not act on it.** There is no automatic reassignment and no severity ladder. Whether to move the next job to someone else, warn the incoming guest, or let it ride is your call, and nothing happens until you make it.
- **"Drive time unknown" means exactly that.** If either property is missing coordinates, the drive between them is counted as zero and the notification says so. The real overrun is at least the number shown, never less.

A turnover with no later job on that crew member's day does not raise this alert, however late it is. There is nobody downstream for it to cascade into.

---

## The Daily Wrap-Up Email

Once a day (evening, Central Time), FieldStay sends a summary email to your account's Owner(s) and Admin(s) covering what happened and what's coming up. It's meant to be the one email that tells you everything you need to know without opening the dashboard, and it only highlights what changed since yesterday rather than repeating the same items every day.

Sections that can appear in the wrap-up (only shown when there's something to report):

- **Tomorrow's turnovers** — what's on deck for the next day
- **Open checklist items** — turnovers with unfinished checklist steps
- **Asset health** — assets that crossed into a worse health tier
- **Vendor compliance expiring** — documents approaching or past their expiration
- **Maintenance** — scheduled maintenance coming due
- **Repeat repairs** — the same category of work order happening repeatedly at the same property (a signal something needs a permanent fix, not another patch)
- **Vacancy gaps** — open nights between bookings
- **Unassigned work orders** — work orders with no vendor or crew assigned yet
- **Sponsors needed** — if your guidebook sponsor count has dropped and you're at risk of losing (or already lost) the unlock
- **Inventory** — pending purchase orders awaiting action

There's a separate, higher-frequency rollup earlier in the day that groups new work orders and RepuGuard review drafts from the last 24 hours into a single bell notification, so those don't spam you individually throughout the day — the evening wrap-up email is the comprehensive one.

---

## Who Receives the Wrap-Up Email

It goes to every Owner and Admin on the account who has accepted their invitation. Managers and Viewers do not currently receive it, and there is no per-user opt-out today — if you don't want it, the current option is to have someone with an Owner/Admin role stop checking it, or contact support if this is a recurring issue for your team.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
