# Stay Evidence: Your Sealed Photo Record

Stay evidence is the sealed photo record FieldStay keeps on every property. Every photo your crew, your vendors, or you take through FieldStay is sealed the moment it is captured and filed to the guest stay it belongs to. When you need to show Airbnb, an owner, or an insurer what a room looked like before and after a guest, the photos are already there.

You do not turn it on. It is on for every property from the day you start.

---

## Where to find it

Open any property and click **Evidence** at the top of the page. The Stay evidence page lists the guest stays for that property, most recent first, going back twelve months and forward sixty days. Select a stay to see the photos that bracket it.

Each stay shows three groups:

- **Before**: photos taken on the turnover before this guest arrived
- **During**: photos taken while this guest was in the home, such as a mid-stay work order
- **After**: photos taken on the turnover after this guest left

A photo from a turnover between two guests appears in both places: as the After for the guest who left and the Before for the guest arriving. Your crew takes it once.

Photos that are not tied to any stay, such as a photo on a vacant home, show under **Not tied to a stay** below the list.

---

## What sealed means

When a photo is taken, FieldStay records four things about it before anything else happens:

1. **A fingerprint.** A unique code computed from the photo's bytes. If the file is ever changed, even by one pixel, the code no longer matches. FieldStay computes it again when the photo reaches the server and records whether the two matched.
2. **The capture time.** The time on the phone when the photo was taken, corrected for any difference between the phone's clock and the server's, with both values kept. A phone with the wrong clock does not produce a wrong record.
3. **Who took it.** The crew member, vendor, or team member who captured it.
4. **Where, when your crew allows it.** If the crew member has allowed location access on their phone, the location at the moment of capture. If not, nothing is recorded. FieldStay never asks for location during a photo. The place a photo is tied to comes from the visit check-in described below.

Each of these is written once and never edited. A photo can be withdrawn, which adds a new entry pointing at the original, but the original stays.

---

## The visit check-in

Every turnover starts with a check-in. When a crew member taps **Start Turnover**, their phone shares its location once, and FieldStay records it on the evidence record with the time, the accuracy, and how far the phone was from the property's map pin. Every photo taken during that visit points back to that check-in, so the packet can show that the crew was at the property when the visit began.

- **Location is required to start.** The phone asks the crew member for location permission the first time. If they decline, the turnover cannot be started from that phone until they allow it in their browser settings. Ticking the first checklist item also starts the turnover, and it does so only when the phone can share its location.
- **Check in again.** Once a turnover is in progress, a **Check in again** button on the turnover screen records a fresh location. Use it when the first reading was poor or the crew member moved from the driveway to the unit. The newest check-in is the one new photos point to.
- **Away from the property.** If a check-in is farther from the property than the check-in radius, you get a notification, "Turnover started away from the property", with the distance. Nothing is blocked. The default radius is about a third of a mile (1,640 feet). To change it, open the property, click **Details**, and set **Crew check-in radius (feet)** to a number from 150 to 16,000. Widen it for a large property or a rural address.
- **Fix a pin that is in the wrong place.** A property's map pin comes from its ZIP code unless the PMS supplies exact coordinates, so on a rural property or a large lot it can sit on the wrong road or in the middle of town, and every visit then reads as away. Open the property, click **Details**, and under the street address click **Use last check-in as map pin**. The pin moves to where your crew last checked in, after you confirm. The button is available when the latest check-in has a location accurate to under 100 feet. Otherwise it says why it is off, and a crew member can check in again outdoors. Past check-ins keep the distance recorded at the time, and a pin you set this way is not overwritten by a sync from your PMS.
- **No map pin.** If the property has no location on the map, FieldStay cannot measure the distance and does not flag anything. You get one notification asking you to verify the property's address.

What it proves: the crew member's phone was at that location when the visit started. What it does not prove: where the phone was when each photo was taken. Distances and accuracy are shown in feet, or miles for longer distances.

---

## What gets sealed

- Every checklist photo on a turnover, including the room photos and claim spot photos (see **Room Photos and Claim Spots**)
- Section photos on a turnover
- Asset discovery photos
- Photos a vendor uploads to a work order
- Photos you attach to a work order
- Photos on a completed inspection
- Quick flag photos on a turnover

---

## Works with no signal

Your crew's phone seals the photo locally, with the real capture time, and syncs it when signal comes back. The record shows the time the photo was taken, not the time it uploaded. See **Installing the Crew App** for how offline sync works.

---

## Who can see what

- **You and your team** see every photo on the Evidence page.
- **Your crew** does not see the Evidence page. They see the photos they took on their own checklist.
- **Vendors** see the photos your team took before they arrived on the work order they were sent (see **Work Order Vendor Dispatch**).
- **Owners** can see the photos behind a charge on their statement, only when you have marked that charge visible to the owner (see **Owner Portal**).

Photos are stored in private storage. A link to view one expires after five minutes.

---

## Common questions

**Can I delete a photo?**
Your team can remove a photo from a work order or checklist, and a vendor can remove one they uploaded. The photo stays on the record, marked as withdrawn, and the withdrawal is dated. This is on purpose. A record you can quietly edit is not a record.

**What if the fingerprint did not match?**
The photo is still sealed and shows a warning on the Evidence page. It means the stored file differs from what the phone captured. This is rare and usually means an upload was interrupted. Retake the photo if you can.

**Does this cost extra?**
No. Every FieldStay subscription includes the full platform. See **Pricing and Plans**.
