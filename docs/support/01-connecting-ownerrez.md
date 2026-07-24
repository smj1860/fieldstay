# Connecting OwnerRez to FieldStay

Connecting OwnerRez syncs your properties, bookings, and guest data into FieldStay
automatically — no manual data entry required.

Using Hospitable instead? See [Connecting Hospitable](./25-connecting-hospitable.md).

## Before You Start
- Active FieldStay account (Starter plan or higher)
- OwnerRez login credentials
- Initial sync takes 1–2 minutes after authorization

## How to Connect
1. Go to Settings → Integrations
2. Click Connect on the OwnerRez card
3. Authorize FieldStay in OwnerRez — click Authorize
4. Wait 1–2 minutes for the initial sync to complete

## What Gets Synced
- Properties: name, address, bedrooms, bathrooms, WiFi credentials, check-in
  instructions, amenity flags, house manual
- Bookings: check-in/checkout dates, guest name/email, booking source, status —
  including owner blocks and tentative/unconfirmed bookings, which sync in and
  are tagged accordingly rather than being left out
- Reviews: your full review history imports on first connect, not just reviews
  from the connection date forward

FieldStay does not write any data back to OwnerRez.

## After Sync Completes
FieldStay automatically generates turnover tasks between consecutive bookings,
calculates preparation windows, flags same-day turnovers, and creates a guidebook
configuration for each property.

## Troubleshooting
If something isn't syncing or showing up the way you expect, use **Trigger
Resync** next to OwnerRez in Settings → Integrations first. If that doesn't
fix it, disconnect and reconnect.

- Properties didn't appear: wait 2–3 minutes and refresh, or use Trigger
  Resync next to OwnerRez in Settings → Integrations
- Error during authorization: make sure you're logged into the correct OwnerRez account
- Bookings not showing: check the date filter on your FieldStay bookings
  page — the default view shows upcoming bookings only
