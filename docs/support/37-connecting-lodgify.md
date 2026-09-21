# Using FieldStay with Lodgify

**Short version: you can use FieldStay with Lodgify today through a calendar (iCal) link. A direct Lodgify connection is built but not switched on yet — if you're on Lodgify, tell us, because you're who we're waiting to test it with.**

---

## What works today

Lodgify publishes an iCal calendar link for each property. FieldStay reads those links, so your bookings flow in automatically and your turnovers get built from them without anyone typing anything.

To set it up, for each property:

1. In **Lodgify**, open the property's calendar and copy its **iCal export link** (the `.ics` URL)
2. In **FieldStay**, go to **Properties → [the property] → Setup → iCal**
3. Choose **Direct / Other** as the source, paste the link, and save

Repeat for each property. FieldStay checks the feeds regularly and creates turnovers between consecutive stays.

### What you get from an iCal feed

- Check-in and check-out dates for every booking
- Turnovers generated automatically between stays, including same-day flips
- Everything FieldStay does downstream of a turnover: crew assignment, checklists, inventory consumption, inspections, work orders

### What an iCal feed cannot give you

This is a limit of the iCal format itself — it is a calendar, not a booking record — so it applies to any platform you connect this way, not just Lodgify:

- **No revenue.** Booking amounts are not in a calendar feed, so owner statements won't show booking revenue from iCal bookings. You can add revenue manually on the booking.
- **No guest details.** Names and email addresses mostly don't travel in an iCal feed.
- **No property details.** Bedrooms, bathrooms, guest capacity, WiFi and check-in instructions all need to be filled in on the property in FieldStay. They're worth doing early: bedroom and bathroom counts drive how many checklist sections a turnover gets and how inventory par levels scale.
- **No reviews.**

If you want those, the direct connection below is what provides them.

---

## The direct Lodgify connection

Lodgify has a public API, and FieldStay's integration with it is written and waiting. It is **not available to turn on yet.** You won't see Lodgify in **Settings → Integrations** while that's the case.

The honest reason: we haven't been able to run it against a real Lodgify account. Everything in it was built from Lodgify's published documentation rather than from a live connection, and we would rather hold it than hand you an integration whose first run is also its first test.

**If you use Lodgify and would be willing to connect a real account, please say so** — that is the one thing standing between this and switching it on.

### What it will do once it's live

- Properties and bookings sync automatically, including 12 months of booking history on first connect
- Booking revenue posts to owner statements, so your P&L is right from day one
- Turnovers build themselves from your Lodgify calendar
- Cancellations come across as cancellations and never generate a turnover

### What it won't do, even then

- **No reviews.** Lodgify's API has no reviews resource at all, so there's nothing for RepuGuard to draft against. Reviews you get through Lodgify will need to be added manually.
- **No staff or crew import.** Lodgify has no staff concept to import from — you'll add crew in FieldStay directly.
- **No owner blocks.** Manually-blocked owner time lives on Lodgify's availability calendar rather than in its bookings, so it won't come across at first.

### What you'll need

Your Lodgify plan has to include **Public API access** (that's Lodgify's Professional plan and above — their Starter plan cannot generate an API key at all). You'll generate a key yourself in Lodgify under **Settings → Public API** and paste it into FieldStay; there's no authorization redirect and nothing to approve.

---

## Disconnecting, and a caveat worth knowing

When the direct connection is live and you disconnect it, FieldStay deletes its copy of your API key and removes any webhooks it registered on your Lodgify account.

**Lodgify provides no way for us to invalidate the key itself.** Unlike OwnerRez or Hostex — where disconnecting actually revokes our access on their side — a Lodgify API key stays valid until you rotate it in Lodgify. If you want FieldStay's access definitively dead rather than merely deleted, rotate the key in **Lodgify → Settings → Public API** after disconnecting. That's a property of Lodgify's API, not a choice FieldStay made.

---

## Switching from iCal to the direct connection later

Worth planning for, because it isn't automatic.

FieldStay matches synced properties to the ones it created from that same PMS. A property you set up by hand for an iCal feed wasn't created by Lodgify, so when you connect Lodgify directly it arrives as a **new** property record rather than merging into the one you already have. You'd end up with two entries for the same house — the hand-made one holding your iCal bookings and your edits, and the synced one holding everything Lodgify knows.

Two ways to avoid the mess:

- **If you're setting up now and expect to connect Lodgify directly soon**, consider waiting and letting the direct connection create your properties. It fills in more than you'd type by hand.
- **If you're already running on iCal**, tell support before you connect. Moving your history — crew assignments, checklists, work orders, inspections — onto the synced property is something we'd rather walk through with you than have you discover afterwards.

This is not specific to Lodgify. It's how every PMS connection behaves when properties already exist by hand.
