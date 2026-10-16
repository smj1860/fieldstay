# How Work Order Dispatch Works — Sending Work Orders to Vendors

When you create a work order and assign a vendor, FieldStay sends that vendor an email dispatch automatically. The vendor receives everything they need to do the job — property details, scope of work, the authorized spending limit, and a secure link to sign off when the work is complete.

You don't send anything manually. The dispatch happens the moment you create and assign the work order.

---

## What the Vendor Receives

The vendor gets an email from FieldStay containing:

- **Work order number** and title
- **Property name and address**
- **Scope of work** description
- **Authorized spending limit (NTE)** — clearly displayed so they know their ceiling before starting
- **Your name** as the dispatcher and your organization name
- **A secure portal link** to view the full work order and sign off when complete

The email is a standard FieldStay dispatch email with a "powered by TradeSuite" footer credit — it isn't a separately-branded vendor platform experience, just a professional, clearly-sourced email regardless of whether the contractor has worked with FieldStay before.

---

## The Vendor Portal Link

The link in the dispatch email is unique to each work order and vendor. When the vendor clicks it, they land on a secure page showing the scope of work, the authorized spending amount, and the date you need it done by.

The link is valid for 30 days. If a vendor needs a new link after it expires, go to the work order detail page and click **Send to Vendor** to generate a fresh one.

**The link is for that vendor, not for passing around.** Access details are withheld until they accept (see below), but the link is still the key to this job. If the vendor needs to hand the job to one of their technicians, there is a built-in way to do that, covered further down, rather than forwarding this link.

---

## Accept or Decline Comes First

A dispatched work order is an offer, not an instruction. The vendor's first action on the portal is to accept or decline it.

**If they accept**, they pick the date they can come and a window: morning, afternoon, evening, all day, or an exact time. That becomes the appointment on the work order, and it is separate from your needed-by date. You set the deadline; they commit to a date inside it.

**If they decline**, they pick a reason: no capacity, outside their service area, not their trade, below their minimum, cannot access the property, or other. The work order returns to unassigned so you can send it elsewhere, and FieldStay notifies you with the reason. Nothing is auto-dispatched to a second vendor on your behalf.

If a dispatched work order sits with no answer, FieldStay nudges the vendor after a day and flags it to you after three.

---

## Access Details Are Held Back Until They Accept

This is deliberate and it is the main thing to know about dispatch.

The dispatch email and the pre-acceptance portal page carry no door code, no access notes and no parking instructions. Those appear only once the vendor has accepted the job. Until then the page does not contain them at all, so a link that reaches the wrong inbox hands over nothing about getting into the property.

The door code comes from the property record, where it is stored encrypted. You set it once on the property and FieldStay sends it; you do not type a code into the work order. The per-job access and parking notes you wrote when creating the work order appear at the same moment, for the same reason.

Every reveal is recorded, naming who saw it and when. The code itself is never written into that record.

If a vendor has accepted and nothing is waiting for them, the page says so and tells them to contact you, rather than implying something will appear later.

---

## Sending the Job to a Technician

Vendors with crews of their own rarely do the work themselves. Rather than forwarding their own link, the vendor can generate a separate link for a named technician from their portal page.

The technician opens it, enters their name, and optionally their own mobile number. From then on their work is recorded under their name instead of a free-text note at the end of the job. The vendor never types their employee's number, and the technician's name becomes a pick-list entry for that vendor's next job.

Each technician link is for one work order only. The vendor can revoke one at any time, and all of them stop working when the job closes. A technician sees the same access gating: nothing until the vendor has accepted.

---

## Progress Updates

After accepting, the vendor can set where the job stands from a dropdown on their portal page: appointment scheduled, on the way, tech on site, waiting on access, waiting on your approval, parts ordered, repair in progress, return visit scheduled, or job completed.

Two of these are asking something of you rather than reporting. **Waiting on access** means they could not get in. **Waiting on your approval** means they have stopped and need a decision, usually about scope or cost. Both notify you straight away instead of only sitting in a dropdown, and both show at the top of the Maintenance board, because only you can unblock them.

The board groups open work orders by where they are in this sequence, with anything waiting on you first.

---

## Photos the Vendor Sees Before Starting

If your team took photos on the work order before the vendor was sent, the vendor's portal page shows them under **Photos from the property manager**. They are read-only and are the only photos from the property the vendor can see. Photos the vendor uploads are sealed to the property's evidence record; a photo the vendor removes stays on the record marked as withdrawn. Each work order has a lifetime limit of 15 vendor uploads.

---

## What Happens When the Vendor Signs Off

When the vendor clicks Sign Off on their portal page, the work order status moves straight to **Completed** and the actual cost posts to the owner financial ledger automatically. There's no separate "pending review" or approval step in between — sign-off is the completion event. You get a notification once it's done, so review what the vendor submitted at that point rather than beforehand.

---

## Resending a Work Order to a Vendor

If a vendor didn't receive the email, if the link expired, or if you're reassigning the work order to a different vendor:

1. Open the work order from the Maintenance board
2. Click the work order to open the detail panel
3. Find the **Send to Vendor** button
4. Confirm or update the vendor email address and click Send

This generates a fresh portal link and sends a new dispatch email.

---

## Checking Whether the Vendor Was Notified

On the work order detail panel, look at the **Dispatched To** field. If it shows an email address, the vendor was notified. If it's blank, the dispatch didn't fire — use the Send to Vendor button to trigger it manually.

---

## What Requires PM Approval Before the Vendor Proceeds

Every work order has a **Not to Exceed (NTE)** amount set when you create it. This is the spending ceiling the vendor is authorized to work within.

If the scope grows beyond the NTE during the job, the vendor is expected to contact you before proceeding. The dispatch email explicitly states this. It is the vendor's responsibility to pause and request approval for any additional scope — FieldStay cannot enforce this automatically but the NTE amount is clearly communicated in every dispatch.

---

## Troubleshooting

**The vendor says they didn't receive the dispatch email.**
Check their spam folder first. If it's not there, open the work order detail panel and use **Send to Vendor** to resend. Confirm the email address on file for the vendor in Vendors (top-level nav, not under Settings).

**The vendor's link isn't working.**
Links expire after 30 days. Use **Send to Vendor** to generate a fresh link.

**The vendor says there's no door code on their page.**
Access details appear only after they accept the job. Ask them to accept first. If they have accepted and still see nothing, check that the property has a door code saved on its own record, since that is where FieldStay sends it from.

**The vendor declined. What happens to the work order?**
It goes back to unassigned with their reason attached, and you get a notification. Assign a different vendor from the Maintenance board when you are ready. FieldStay does not pick a replacement for you.

**The dispatch email didn't send when I created the work order.**
The vendor must have an email address on file and the portal option must be enabled when creating the work order. Check the vendor's profile in Vendors (top-level nav, not under Settings) to confirm their email is set. Then use **Send to Vendor** from the work order detail panel to dispatch manually.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
