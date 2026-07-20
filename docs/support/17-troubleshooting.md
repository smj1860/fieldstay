# Troubleshooting — Common Issues and Fixes

This document covers the most common issues reported by property managers and how to resolve them.

---

## Turnovers Not Generating After a Booking Syncs

**Symptom:** A new booking appeared in OwnerRez but no turnover was created in FieldStay.

**Check first:**
- Is the booking status "Confirmed" in OwnerRez? Tentative or unconfirmed bookings do not generate turnovers.
- Is the booking marked as a block or owner hold? Block bookings are filtered out.
- Was the booking created before you connected OwnerRez? Only bookings created or modified after the connection date sync automatically.

**Fix:**
Go to your Turnovers dashboard and click **Sync** to trigger a manual re-sync. If the booking is confirmed and not a block, the turnover should appear within 1–2 minutes.

If it still doesn't appear, disconnect and reconnect OwnerRez from Settings → Integrations.

---

## Crew Member Cannot Log In or Doesn't See Their Turnovers

**Symptom:** A crew member accepted their invite but can't log in, or they're logged in but their turnovers don't appear.

**Check first:**
- Did they accept the invitation email? Crew members must click the link in the invite email to activate their account. The link expires after 7 days.
- Are they assigned to the turnovers? Crew members only see turnovers explicitly assigned to them or to properties they are assigned to.
- Are they using the correct URL? The crew app is at `app.fieldstay.app/crew` — not the PM dashboard.

**Fix:**
Go to Settings → Crew, find the crew member, and click **Resend Invite** if their invite expired. Check the turnovers in question and confirm the crew member is assigned.

---

## Inventory Count Submitted But No Restock Email

**Symptom:** Crew submitted an inventory count with items below par but the PM didn't receive a restock order email.

**Check first:**
- Were any items actually below par? FieldStay only sends a restock email if at least one item counted below its par level.
- Was this a same-day flip property? Same-day flip properties send immediately. All others send in the end-of-day summary around 6 PM.
- Check your spam folder — restock emails come from no-reply@fieldstay.app.

**Fix:**
If items were below par and the email didn't arrive by end of day, check Settings → Notifications to confirm the PM email address is correct. Contact support@fieldstay.app if the issue persists.

---

## Guidebook Not Showing for Guests

**Symptom:** A guest followed the guidebook link but sees an error or a blank page.

**Check first:**
- Is the guidebook published? Go to Guidebook → [Property Name] and confirm the **Published** toggle is on. Unpublished guidebooks return a not-found page.
- Is the link correct? Each booking has a unique tokenized link. The link from one booking does not work for a different booking.
- Has the booking checkout date passed? Guidebook links expire after checkout.

**Fix:**
Publish the guidebook from Guidebook → [Property Name] → toggle Published. For guests who have the wrong link, resend the pre-arrival email from the booking detail page.

---

## OwnerRez Sync Showing Stale Data

**Symptom:** Changes made in OwnerRez (updated booking dates, new properties) are not reflecting in FieldStay.

**Check first:**
- Was the change made recently? Webhook events can take a few minutes to process.
- Is the OwnerRez integration still connected? Go to Settings → Integrations and confirm OwnerRez shows as Connected.

**Fix:**
Click **Sync** on the Turnovers dashboard to trigger an immediate re-sync. If the integration shows as disconnected, reconnect from Settings → Integrations — this happens when an OwnerRez password is changed or access is revoked.

---

## Vendor Portal Link Not Working

**Symptom:** A vendor clicks the link in their dispatch email and gets an error.

**Check first:**
- Has the work order been cancelled? Cancelled work orders deactivate the portal link.
- Is the link older than 90 days? Portal links expire after 90 days.

**Fix:**
Go to the work order in FieldStay and click **Resend Dispatch**. This generates a fresh dispatch email with a new valid link to the vendor.

---

## Crew App Showing Offline When There's Connectivity

**Symptom:** The crew app displays an "Offline" or sync indicator even though the device has WiFi or cell signal.

**Check first:**
- Is the device connected to a network that blocks certain ports or domains? Some property WiFi networks use content filters that block app sync.
- Did the app update recently? A stale service worker can sometimes cause incorrect offline state.

**Fix:**
Have the crew member close the app completely and reopen it. If that doesn't resolve it, clear the browser cache for the app (on iPhone: Settings → Safari → Clear History and Website Data, then reinstall the PWA). On Android: Settings → Apps → Chrome → Storage → Clear Cache.

If the offline state persists only at a specific property, the property's WiFi may be blocking sync traffic. The app will still function offline and sync when the crew member has a signal outside the property.

---

## Work Order Not Dispatching to Vendor

**Symptom:** A work order was assigned to a vendor but they never received the dispatch email.

**Check first:**
- Does the vendor have an email address on file? Go to Vendors → [Vendor Name] and confirm an email address is listed.
- Is the vendor's portal feature enabled? Some vendors may have portal access disabled.
- Is the vendor Hard Blocked for compliance? A vendor with an expired COI over 46 days cannot be assigned to work orders.

**Fix:**
Confirm the vendor's email in their profile, then go to the work order and click **Resend Dispatch**. Check the vendor's spam folder — dispatch emails come from no-reply@fieldstay.app.

---

## Need Help?

If none of the above resolves your issue, email **support@fieldstay.app** with a description of the problem, which property it affects, and any error messages you're seeing.
