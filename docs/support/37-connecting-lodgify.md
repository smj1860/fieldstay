# Connecting Lodgify to FieldStay

Connecting your Lodgify account takes about two minutes. Once connected, your properties and bookings sync automatically, booking revenue posts to owner statements, and turnovers are built from your Lodgify calendar.

---

## Before You Connect

You need a Lodgify account on a plan that includes **Public API access** — that is Lodgify's Professional plan and above. Lodgify's Starter plan cannot generate an API key at all, so the connection is not possible on it. If you try, FieldStay tells you the plan is the problem rather than claiming your key is invalid.

You'll also need to be logged into FieldStay as an Owner or Admin — Managers cannot connect integrations.

---

## How to Connect

Unlike OwnerRez, Hospitable and Hostex, there is no authorization redirect. You generate a key in Lodgify and paste it into FieldStay.

1. In **Lodgify**, go to **Settings → Public API** and copy your API key
2. In **FieldStay**, go to **Settings → Integrations**
3. Find Lodgify and click **Connect**
4. Paste the key and save

FieldStay checks the key against your Lodgify account before storing it, so an invalid key or a plan without API access fails immediately rather than appearing to connect and then syncing nothing. Within a minute or two your properties and bookings begin appearing.

---

## What Syncs When You Connect

### Properties

Every active property in your Lodgify account syncs, with name, address, and map coordinates. Room counts and guest capacity come across where Lodgify publishes them.

Where Lodgify does not publish a value, FieldStay does **not** guess one. Bedroom count, bathroom count and guest capacity arrive with FieldStay's own starting values (1 bedroom, 1 bathroom, 2 guests, 3:00 PM check-in, 11:00 AM checkout) for you to correct.

Correcting them early is worth the minute it takes, because those numbers drive real work: turnover checklists get one section per bedroom and bathroom, and smart inventory par levels scale with bedrooms, bathrooms and guest capacity.

**Your corrections are permanent.** A later re-sync will not overwrite a bedroom count you set — where Lodgify has no value of its own, FieldStay leaves yours alone rather than re-asserting a default over it.

WiFi details, check-in instructions and house rules are yours to fill in on the property; Lodgify's API does not expose them, so nothing FieldStay syncs will ever overwrite what you type there.

### Bookings

Your first sync pulls **12 months of booking history and 6 months forward**, so owner statements and P&L have a real first year rather than starting from today.

Each booking arrives with guest name, check-in and check-out dates, booking channel (Airbnb, Vrbo, Booking.com, direct) and total. Turnovers are generated automatically between consecutive stays, including same-day flips.

Cancelled and declined bookings come across as cancelled, and never generate a turnover.

### Revenue

Booking totals post to the owner ledger automatically, so P&L and owner statements reflect real revenue from day one rather than an estimate.

The figure is the booking total as Lodgify reports it, before any channel commission. If you net commissions out on your statements today, that difference is worth knowing about.

---

## What Does Not Sync, and Why

These are limits of what Lodgify's API publishes, not features FieldStay chose to skip:

- **Reviews.** Lodgify's API has no reviews resource at all, so there is nothing for RepuGuard to draft against. Reviews that come through Lodgify need to be added to FieldStay manually if you want a drafted response.
- **Staff or crew.** Lodgify has no staff concept to import from. Add your crew in FieldStay directly — **Team → Crew Members**.
- **Owner blocks.** Time you block on your own calendar lives on Lodgify's availability calendar rather than in its bookings, so it does not come across yet. A blocked period will not show as a booking in FieldStay.

---

## How Often It Syncs

**Lodgify syncs once daily.** Most FieldStay integrations receive changes within seconds through webhooks; Lodgify's webhook delivery is held off until we have verified how it behaves against a live account, so a change made in Lodgify can take up to 24 hours to appear on its own.

You are not stuck waiting for it. **Trigger Resync** on **Settings → Integrations** pulls everything immediately — properties as well as bookings — and is the right thing to click after you add a property or change a booking you need reflected now.

When webhook delivery is switched on, existing connections pick it up automatically on their next daily sync. Nothing to reconnect.

---

## Disconnecting, and a Caveat Worth Knowing

Disconnecting removes FieldStay's copy of your API key and removes any webhooks FieldStay registered on your Lodgify account.

**Lodgify provides no way for us to invalidate the key itself.** With OwnerRez or Hostex, disconnecting actually revokes our access on their side. A Lodgify API key stays valid until you rotate it in Lodgify. If you want FieldStay's access definitively dead rather than merely deleted, rotate the key in **Lodgify → Settings → Public API** after disconnecting.

That is a property of Lodgify's API rather than a choice FieldStay made, and it is the reason this page says so plainly instead of leaving you to assume otherwise.

---

## If You Are Already Running on an iCal Link

Worth planning for, because it is not automatic.

FieldStay matches synced properties to ones it created from that same PMS. A property you set up by hand for an iCal feed was not created by Lodgify, so connecting Lodgify brings that property in as a **new** record rather than merging into the one you already have. You would end up with two entries for the same house — the hand-made one holding your iCal bookings and edits, and the synced one holding what Lodgify knows.

**Tell support before you connect.** Moving your history — crew assignments, checklists, work orders, inspections — onto the synced property is something we would rather walk through with you than have you discover afterwards.

This is not specific to Lodgify. It is how every PMS connection behaves when properties already exist by hand.

---

## If Something Looks Wrong

Lodgify is FieldStay's newest integration. If a sync reports an error, or your property or booking counts do not match what you see in Lodgify, tell support and say what you expected — that is genuinely useful to us and we will look at it directly. FieldStay is built to fail visibly rather than quietly here: a sync that cannot read something reports an error on the connection in **Settings → Integrations** rather than importing partial data and looking finished.
