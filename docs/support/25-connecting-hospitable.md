# Connecting Hospitable to FieldStay

Connecting your Hospitable account to FieldStay takes about two minutes. Once connected, your properties, upcoming bookings, and cleaning crew sync automatically — and stay in sync in real time through webhooks whenever something changes in Hospitable.

---

## Before You Connect

You need an active Hospitable host account at **my.hospitable.com**. If you manage your short-term rental listings through Hospitable, you already have one.

You'll also need to be logged into FieldStay as an Owner or Admin — Managers cannot connect integrations.

---

## How to Connect

1. In your FieldStay dashboard, go to **Settings → Integrations**
2. Find Hospitable and click **Connect**
3. You'll be redirected to Hospitable's authorization page — log in with your Hospitable account credentials
4. Click **Authorize** to grant FieldStay read access to your account
5. You'll be redirected back to FieldStay automatically

Within a minute or two, your properties and bookings will begin appearing in FieldStay.

---

## What Syncs When You Connect

### Properties
All properties in your Hospitable account sync as active properties in FieldStay. Property name, address, check-in and check-out times, and bedroom count all come across automatically.

### Bookings
Upcoming reservations sync with guest name, check-in and check-out dates, and channel source (Airbnb, Vrbo, direct, etc.). Turnovers are generated automatically between consecutive bookings.

### Crew Members
If you have teammates set up in Hospitable (under Operations → Teammates), they sync into FieldStay as crew members automatically. Their name, email, phone number, and role are all carried across. Hospitable roles map to FieldStay roles as follows:

| Hospitable Role | FieldStay Crew Role |
|---|---|
| Cleaning | Cleaning |
| Laundry | Cleaning |
| Maintenance | Maintenance |
| Check-in / Check-out | Crew |
| Concierge | General |
| Manager | Manager |
| Owner | Owner |

### Turnover Checklists
Once properties sync, FieldStay applies your master turnover checklist template to each property automatically. Crew members will see their checklists the next time they open the crew app.

---

## What Stays in Sync After the Initial Connection

FieldStay receives real-time updates from Hospitable via webhooks. You don't need to manually sync anything. Specifically:

- **New or modified reservations** — appear in FieldStay within seconds of being created or changed in Hospitable
- **Cancelled reservations** — automatically marked as cancelled in FieldStay; associated turnovers are updated
- **Property changes** — name, address, and timing updates sync automatically
- **New reviews** — sync automatically and trigger a RepuGuard draft response

Crew/teammate changes in Hospitable do not sync automatically after the initial connection. If you add or update teammates in Hospitable, disconnect and reconnect FieldStay to re-run the crew sync.

---

## What FieldStay Does Not Write Back to Hospitable

FieldStay is read-only against your Hospitable account. Turnovers, crew assignments, work orders, and anything you do inside FieldStay does not change your Hospitable data. Your Hospitable account remains your system of record for listings and reservations.

---

## Disconnecting Hospitable

Go to **Settings → Integrations → Hospitable → Disconnect**.

Disconnecting removes the OAuth tokens from FieldStay but does not delete your properties, bookings, or crew members that already synced. Your operational data stays intact — you just won't receive new updates from Hospitable until you reconnect.

---

## Troubleshooting

**Properties aren't showing up after connecting.**
Wait two to three minutes and refresh the properties page. If they still don't appear, go to Settings → Integrations and check that Hospitable shows a Connected status. If it shows an error, disconnect and reconnect.

**A booking I see in Hospitable isn't in FieldStay.**
Bookings sync in real time via webhook. If a booking isn't appearing, check the date range on your FieldStay bookings page — the default filter shows upcoming bookings only. If the booking is upcoming and still missing, disconnect and reconnect Hospitable to trigger a fresh sync.

**My crew members from Hospitable didn't sync.**
Hospitable teammate sync requires the `teammate:read` scope to be enabled for the FieldStay integration. If your crew didn't appear after connecting, contact support — this scope may not be active for your account yet.

**I added a new property in Hospitable but it isn't in FieldStay.**
Property additions trigger a sync automatically. If the property doesn't appear within a few minutes, disconnect and reconnect Hospitable.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
