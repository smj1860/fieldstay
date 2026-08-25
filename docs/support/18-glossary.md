# FieldStay Glossary — Key Terms and Concepts

Quick definitions of FieldStay-specific terminology.

---

## Turnover

A turnover is the preparation period between a guest checking out and the next guest checking in at a property. FieldStay creates a turnover automatically when a booking is confirmed in your connected PMS (OwnerRez, Hospitable, or Hostex), using the checkout and check-in dates to define the available prep window.

Turnovers contain the cleaning checklist, inventory count, and any assigned crew. They are distinct from the bookings themselves — a booking is a reservation, a turnover is the operational task triggered by that reservation.

---

## Booking

A booking is a confirmed reservation at a property, synced from your connected PMS (OwnerRez, Hospitable, or Hostex). Bookings contain guest information (name, email, arrival and departure dates, booking source) and are the trigger for turnover creation and guest guidebook delivery.

FieldStay does not create bookings — they always originate in your PMS and sync into FieldStay automatically.

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

The vendor portal is a secure, tokenized web page that a vendor accesses through the link in their dispatch email. It does not require a FieldStay account. Through the portal, the vendor can review work order details, submit line items and a completion photo, and sign off when work is complete. The portal link is unique to each work order and expires after 30 days.

---

## Owner Portal

The owner portal is a secure, tokenized web page shared with property owners. It does not require a FieldStay account. The portal shows the owner a read-only view of their property's financial performance — revenue, expenses, and net income. Property managers control which line items are visible to owners.

---

## RepuGuard

RepuGuard is FieldStay's AI-powered review response tool. It automatically generates professional draft responses to guest reviews synced from your connected PMS (OwnerRez, Hospitable, or Hostex), and flags sensitive content before you post. Posting the approved response is a manual step on the review's original platform — see **RepuGuard — Responding to Reviews** for exactly how that works for each source. RepuGuard is bundled into every FieldStay plan at no extra cost.

---

## Guidebook

The Guest Guidebook is a personalized, mobile-friendly page delivered to guests before and during their stay. It contains their door code, WiFi credentials, check-in instructions, house rules, and local recommendations from sponsored businesses. Each booking gets a unique guidebook link. Guests can also opt in to receive the guidebook content via SMS.

---

## Par Level

A par level is the minimum quantity of a supply item that should be on hand at a property before triggering a restock order. Crew members count inventory during each turnover. Items that fall below par are added to a purchase order automatically — if Kroger is connected, you then click **Build Cart** on the Inventory → Portfolio page to add those items to your Kroger cart yourself; cart-building is a manual step, not an automatic one.

Par levels are per item per property. Most set themselves — see Scaling Par Level below — and any of them can be overridden by clicking the number at Inventory → [Property Name].

---

## Scaling Par Level

Most supply items do not carry one fixed quantity across a portfolio; they scale with the size of each property. Bathroom items (towels, bath mats, toiletries) scale with the bathroom count, bedroom items (hangers, spare linens) with the bedroom count, and guest consumables (coffee, dinnerware, glasses) with how many guests the property sleeps — each with a safety buffer on top. This is why the same catalog item shows a different number at a 1-bathroom condo than at a 4-bathroom lodge.

Editing a property's bedrooms, bathrooms or max guests rescales its items within a few seconds. Items that do not vary with property size — a plunger, a first aid kit — stay a fixed quantity everywhere.

If you type your own number for an item, that number is used as-is and the item then scales from yours rather than the FieldStay default.

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

---

## Inspection

A structured walk-through of a property recorded against a fixed form. FieldStay has three: **Safety & Risk Mitigation**, **Indoor Property & Inventory**, and **Outdoor Property & Grounds**.

Distinct from a turnover checklist, and the difference is what each is for. A checklist is an operational to-do list for one guest changeover, and it is disposable. An inspection is evidence — it is retained permanently, cannot be edited once completed, posts to the owner portal, and is meant to be shown to an insurer or a permitting authority as a multi-year record.

---

## Inspection template (safety cadence)

The org-level answer to "how often should safety inspections run, and starting which month". Set during onboarding and editable in Settings.

It is a template rather than a setting because one answer produces a schedule on every property — including properties added months later, which are picked up automatically. Twice a year means the chosen month and the month six after it.

---

## Inspection schedule

The per-property recurring record produced by the template, holding the next due date and the form to walk. It lives alongside scheduled maintenance and behaves like it, with one difference: when it comes due it **notifies** rather than creating anything, because the inspection record is only created when somebody actually starts the walk.

---

## Vacancy nudge

The rule that moves an inspection's due date onto a day the property is empty. After a property's first completed inspection, FieldStay picks a due date inside a gap between bookings in the target month rather than a fixed day.

This is why two properties on the same cadence come due on different days of the same month, and why a due date can move earlier as well as later. If there is no vacant day that month, the date stands and the inspection shows as due anyway.

---

## Remediation

What a failed inspection item turns into on completion — a work order, a purchase order, a notification, or a recorded fact with no action. The item's definition decides which, so the same failure always produces the same kind of record.

Cleaning failures are rolled up into one cleaning work order per walk, and everything purchasable goes onto one purchase order per walk, rather than one record per failed item.

---

## Repeat visit prompt

The question the form asks when an item fails and a work order from a previous failure of that same item is still open: is this **the same problem**, or a **new one**?

FieldStay asks rather than deciding because both answers are wrong some of the time. Quarterly inspections make repeat failures normal, and one item can cover unrelated faults — "Refrigeration" failing for a water filter in one quarter and a compressor the next is one item and two jobs.

