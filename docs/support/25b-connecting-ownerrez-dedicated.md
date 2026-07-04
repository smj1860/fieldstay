# Connecting OwnerRez to FieldStay

Connecting your OwnerRez account to FieldStay takes about two minutes. Once connected, your properties, bookings, and door codes sync automatically — and stay in sync in real time whenever a new booking is made, modified, or cancelled in OwnerRez.

---

## Before You Connect

You need an active OwnerRez account with at least one property. You'll also need to be logged into FieldStay as an Owner or Admin.

---

## How to Connect

1. In your FieldStay dashboard, go to **Settings → Integrations**
2. Find OwnerRez and click **Connect**
3. You'll be prompted to enter your OwnerRez API credentials — your OwnerRez username and API key
4. Your OwnerRez API key is found in your OwnerRez account under **Tools → API**
5. Enter both and click **Connect**

Within a few minutes, your properties and bookings will appear in FieldStay.

---

## What Syncs When You Connect

### Properties
All properties in your OwnerRez account sync to FieldStay with their name, address, check-in and check-out times, and bedroom count.

### Bookings
All upcoming reservations sync with guest name, check-in and check-out dates, channel source (Airbnb, Vrbo, direct, etc.), and door access codes. Turnovers are generated automatically between consecutive bookings.

### Door Codes
Door access codes from OwnerRez sync automatically and are available to crew members in the FieldStay Crew App on the day of their assigned turnover. Crew can see the door code to access the property for cleaning without you needing to share it separately.

### Turnover Checklists
Once properties sync, FieldStay applies your master turnover checklist template to each property automatically.

---

## What Stays in Sync After the Initial Connection

FieldStay receives real-time updates from OwnerRez via webhooks. You don't need to manually sync or refresh anything:

- **New bookings** — appear in FieldStay within seconds of being created in OwnerRez
- **Modified bookings** — date changes, guest name updates, and cancellations sync immediately
- **Door code changes** — when a door code updates in OwnerRez, it updates in FieldStay automatically, including the code crew members see in the app

You can also trigger a manual sync at any time from the Bookings page using the **Sync** button.

---

## What FieldStay Does Not Write Back to OwnerRez

FieldStay is read-only against your OwnerRez account. Everything you do in FieldStay — turnovers, crew assignments, work orders, maintenance logs — stays in FieldStay and does not change your OwnerRez data. OwnerRez remains your system of record for bookings and channel management.

---

## Disconnecting OwnerRez

Go to **Settings → Integrations → OwnerRez → Disconnect**.

Disconnecting stops new data from syncing but does not delete your existing properties, bookings, or operational history in FieldStay. Your data stays intact — you just won't receive updates from OwnerRez until you reconnect.

---

## Troubleshooting

**Properties aren't showing up after connecting.**
Wait two to three minutes and refresh the properties page. If they still don't appear, go to Settings → Integrations and check that OwnerRez shows a Connected status.

**A booking in OwnerRez isn't showing up in FieldStay.**
Bookings sync in real time. If a booking is missing, check the date filter on your FieldStay bookings page — the default shows upcoming bookings only. Use the **Sync** button on the Bookings page to trigger a manual pull.

**My door codes aren't showing in the crew app.**
Door codes come from OwnerRez only when the booking includes a code. If OwnerRez doesn't have a door code attached to a booking, FieldStay won't have one either. Check the booking in OwnerRez first to confirm the code is set there.

**I changed my OwnerRez API key and now the connection shows an error.**
Go to Settings → Integrations → OwnerRez → Disconnect, then reconnect with your new API key.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
