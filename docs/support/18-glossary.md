# FieldStay Glossary — Key Terms and Concepts

Quick definitions of FieldStay-specific terminology.

---

## Turnover

A turnover is the preparation period between a guest checking out and the next guest checking in at a property. FieldStay creates a turnover automatically when a booking is confirmed in OwnerRez, using the checkout and check-in dates to define the available prep window.

Turnovers contain the cleaning checklist, inventory count, and any assigned crew. They are distinct from the bookings themselves — a booking is a reservation, a turnover is the operational task triggered by that reservation.

---

## Booking

A booking is a confirmed reservation at a property, synced from OwnerRez. Bookings contain guest information (name, email, arrival and departure dates, booking source) and are the trigger for turnover creation and guest guidebook delivery.

FieldStay does not create bookings — they always originate in OwnerRez and sync into FieldStay automatically.

---

## Same-Day Flip

A same-day flip is when a guest checks out and a new guest checks in on the same day at the same property. Same-day flips are flagged on the Turnovers Board because the preparation window is tighter — crew must complete the turnover between the morning checkout and the afternoon check-in.

Same-day flips also trigger immediate inventory restock notifications rather than waiting for the end-of-day summary.

---

## Work Order

A work order is a discrete maintenance or repair task assigned to a vendor or crew member at a specific property. Work orders track the scope of work, cost, and completion status. When a vendor completes a work order through the vendor portal, the actual cost posts automatically to the owner financial ledger.

Work orders differ from maintenance schedules — a work order is a one-time task, while a maintenance schedule is a recurring checklist that generates work orders on a defined cadence.

---

## Maintenance Schedule

A maintenance schedule is a recurring task template that automatically creates work orders when a due date is reached — HVAC filter changes, pest control, gutter cleaning, and similar periodic tasks. Schedules have a defined frequency (monthly, quarterly, annually) and can be linked to a specific vendor or asset.

---

## Vendor Portal

The vendor portal is a secure, tokenized web page that a vendor accesses through the link in their dispatch email. It does not require a FieldStay account. Through the portal, the vendor can review work order details, submit line items and a completion photo, and sign off when work is complete. The portal link is unique to each work order and expires after 90 days.

---

## Owner Portal

The owner portal is a secure, tokenized web page shared with property owners. It does not require a FieldStay account. The portal shows the owner a read-only view of their property's financial performance — revenue, expenses, and net income. Property managers control which line items are visible to owners.

---

## RepuGuard

RepuGuard is FieldStay's AI-powered review response tool. It automatically generates professional draft responses to guest reviews synced from OwnerRez, flags sensitive content before you post, and lets you post the approved response back to OwnerRez in one click. RepuGuard is bundled into every FieldStay plan at no extra cost.

---

## Guidebook

The Guest Guidebook is a personalized, mobile-friendly page delivered to guests before and during their stay. It contains their door code, WiFi credentials, check-in instructions, house rules, and local recommendations from sponsored businesses. Each booking gets a unique guidebook link. Guests can also opt in to receive the guidebook content via SMS.

---

## Par Level

A par level is the minimum quantity of a supply item that should be on hand at a property before triggering a restock order. Crew members count inventory during each turnover. Items that fall below par are added to a purchase order and — if Kroger is connected — automatically added to a shopping cart. Par levels are set per item per property and can be adjusted at any time.

---

## Sponsor

A sponsor is a local business featured in your guest guidebook. Sponsors pay $15/month per featured slot and can appear in the guidebook and in contextual SMS recommendation messages sent to opted-in guests during their stay. Sponsors generate plan credits that reduce or eliminate your FieldStay subscription cost.

---

## Compliance Gate

The compliance gate is the system that checks a vendor's insurance and licensing documents before allowing them to be assigned to a work order. A vendor with an expired certificate of insurance can be soft-blocked (requires PM acknowledgment) or hard-blocked (cannot be assigned) depending on how long the document has been expired.

---

## 10DLC

10DLC (10-Digit Long Code) is the carrier-regulated framework for business SMS messaging in the US and Canada. FieldStay is registered as an A2P (Application-to-Person) sender, which means guest messages come from a dedicated number and are compliant with TCPA regulations. SMS features require an active 10DLC campaign registration.

---

## Dexie / Local-First

The crew mobile app stores data locally on the device using Dexie.js (a local IndexedDB database). This is what makes the crew app work offline — checklists, inventory counts, and photos all function without internet access. Changes sync to FieldStay's servers automatically when connectivity is restored. PMs do not interact with Dexie directly — it is an internal implementation detail of the crew app.
