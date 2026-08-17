# Connecting Hostex to FieldStay

Connecting your Hostex account to FieldStay takes about two minutes. Once connected, your properties, reservations, reviews, and schedule staff sync automatically — and stay in sync through webhooks whenever something changes in Hostex.

---

## Before You Connect

You need an active Hostex host account at **hostex.io**, on a plan that includes API access. If your Hostex subscription has expired or is on the Basic edition, the connection will authorize but syncs will fail — FieldStay will tell you so rather than retrying silently.

You'll also need to be logged into FieldStay as an Owner or Admin — Managers cannot connect integrations.

---

## How to Connect

1. In your FieldStay dashboard, go to **Settings → Integrations**
2. Find Hostex and click **Connect**
3. You'll be redirected to Hostex's authorization page — log in with your Hostex account credentials
4. Click **Authorize** to grant FieldStay read access to your account
5. You'll be redirected back to FieldStay automatically

Within a minute or two, your properties and reservations will begin appearing in FieldStay.

---

## What Syncs When You Connect

### Properties

All properties in your Hostex account sync as active properties in FieldStay, with name, address, and exact map coordinates.

**Hostex's API does not expose bedroom count, bathroom count, guest capacity, wifi details, check-in instructions, house rules, or amenities.** This is a limit of what Hostex publishes, not something FieldStay chose to skip. Those fields are not guessed — each property arrives with FieldStay's own starting values (1 bedroom, 1 bathroom, 2 guests, 3:00 PM check-in, 11:00 AM checkout) for you to correct.

Correcting them is worth doing early, because bedroom and bathroom counts drive real work: turnover checklists get one section per bedroom and bathroom, and smart inventory par levels scale with bedrooms, bathrooms, and guest capacity. Edit them on the property card or in **Property Setup → Details** and both the checklist and the par levels update to match.

**Your corrections are permanent.** A later re-sync will not overwrite a bedroom count you set, because Hostex has no value of its own to write there.

### Cleaning Cost

FieldStay reads the cleaning fees on your Hostex reservations and sets each property's cleaning cost from them, so owner statements and P&L have a real number from day one. Where a property has several reservations with different fees, FieldStay uses the typical one rather than the highest or lowest. This only fills a cleaning cost you haven't set yourself — your own number always wins.

### Reservations

Reservations sync with guest name, check-in and check-out dates, channel source (Airbnb, Vrbo, Booking.com, direct), and revenue. Turnovers are generated automatically between consecutive stays, and booking revenue posts to the owner ledger.

Cancelled, denied, and expired reservation requests all come across as cancelled — they never generate a turnover.

### Reviews

Guest reviews sync automatically and queue a RepuGuard draft response. See **Posting responses** below for how posting works with Hostex.

### Staff

Your Hostex schedule staff — cleaners, operators, receptionists, and anyone else — sync into FieldStay as crew members with their name, email, and phone.

Hostex staff records carry no role field, so FieldStay infers each person's role from the work they're actually scheduled for: someone whose tasks are mostly cleaning comes across as Cleaning, mostly maintenance as Maintenance, and so on. Anyone whose work doesn't map to a FieldStay role — a receptionist, for example — comes across as General, with what they actually do recorded in their **Specialty** field so nothing is lost.

Staff with no scheduled tasks yet come across as General.

**A role you set is permanent.** Change anyone's role in **Settings → Crew** and the daily sync will never touch it again — including changing someone to General, or leaving them there deliberately. FieldStay only infers a role the first time it sees a staff member; after that, your choice is the answer. The trade is that someone who had no tasks at their first sync stays General until you set them, so it's worth a quick pass over your crew list after connecting.

### Turnover Checklists

Once properties sync, FieldStay applies your master turnover checklist template to each property automatically. Because Hostex doesn't report bedroom counts, correct those first if you want the right number of bedroom sections from the start — or correct them later and the checklist will top itself up.

---

## What Stays in Sync After the Initial Connection

FieldStay registers a webhook with Hostex and receives updates as they happen:

- **New or modified reservations** — appear in FieldStay within seconds
- **Cancelled reservations** — marked cancelled in FieldStay; the associated turnover is updated
- **New and updated reviews** — sync automatically and trigger a RepuGuard draft

**Hostex does not retry a webhook it fails to deliver.** Most integrations will resend a delivery that didn't land; Hostex sends once. So FieldStay also runs a full reservation sweep every day at 8:00 AM UTC that catches anything a missed delivery would otherwise have lost. A booking that slipped through a webhook outage appears by the next morning at the latest — and you can pull it in immediately with **Trigger Resync**.

---

## What FieldStay Does Not Write Back to Hostex

FieldStay is read-only against your Hostex account. Turnovers, crew assignments, work orders, and anything you do inside FieldStay does not change your Hostex data. Your Hostex account remains your system of record for listings and reservations.

---

## Posting Review Responses

RepuGuard drafts a response to every synced Hostex review, but Hostex's API doesn't give FieldStay a link back to the review on its original channel. So for Hostex reviews, click **Mark as Posted**, post your approved response wherever the review actually lives (Airbnb, Vrbo, or the Hostex inbox), and confirm — the same flow as Hospitable and manually-added reviews. OwnerRez is the only source with a direct link back today.

---

## Disconnecting Hostex

Go to **Settings → Integrations → Hostex → Disconnect**.

FieldStay revokes its access at Hostex — both the access token and the longer-lived refresh token — and removes them locally. Your properties, bookings, crew, and reviews that already synced stay exactly as they are. You just won't receive new updates until you reconnect.

---

## Troubleshooting

If something isn't syncing the way you expect, use **Trigger Resync** next to Hostex in Settings → Integrations first. If that doesn't fix it, disconnect and reconnect.

**Properties are missing bedroom, bathroom, or guest counts.**
Expected — Hostex doesn't publish them. See **Properties** above. Set them on the property card and your checklists and par levels follow.

**Everything stopped syncing and nothing looks broken.**
Check your Hostex subscription. If it expired or downgraded to Basic, Hostex rejects API calls for the whole account. FieldStay stops retrying rather than hammering a request that cannot succeed, so the fix is on the Hostex side — renew or upgrade in the Hostex portal and syncing resumes on the next run.

**Settings shows Hostex as connected, but nothing has synced for days.**
Hostex has no way to notify FieldStay that a host revoked access on their side — no other integration FieldStay supports has this gap. FieldStay finds out the next time a sync or token renewal fails, which can be up to a week later. If a connection looks stale, use **Trigger Resync**: it will either recover or surface the real error immediately.

**A reservation in Hostex isn't in FieldStay.**
Check the date range on your bookings page first — the default view shows upcoming bookings only. If it's upcoming and still missing, it may have been a missed webhook; use **Trigger Resync** rather than waiting for the daily sweep.

**My Hostex staff came in with the wrong role.**
Roles are inferred from scheduled tasks, so a staff member with no tasks yet, or with a mix, may land on General. Change the role in **Settings → Crew** and it sticks permanently — the sync never revisits a role once it's been set.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
