# Work Orders — Creating and Dispatching

**Work orders let you assign specific maintenance or repair tasks to vendors or crew, track progress, and automatically post costs to your owner financial ledger.**

---

## Creating a Work Order

Go to **Maintenance → New Work Order** and fill in:

- **Property** — which property the work is at
- **Title** — brief description of what needs to be done
- **Description** — full details, access notes, anything the vendor needs to know
- **Priority** — Low, Medium, High, or Urgent
- **Scheduled date** — when the work should happen
- **NTE amount** — Not-To-Exceed limit (optional, shown to vendor)

---

## Assigning to a Vendor vs Crew

At the top of the work order form, choose how you want to assign it:

**Assign Vendor** — sends the work order to an external contractor via email. The vendor receives a dispatch email with a secure link to a vendor portal where they can:
- Review the work order details
- Submit line items and a completion photo
- Sign off when work is complete

**Assign Crew** — routes the task to one of your crew members. It appears in their crew app alongside turnovers. Crew complete it using a simple Mark Complete flow with optional notes. No invoice or vendor portal is involved.

Use Assign Vendor for licensed contractors, trades, or specialized work. Use Assign Crew for simple tasks your in-house team handles.

---

## One-Off Projects for Your Own Crew

A work order does not have to be a repair, and it does not have to belong to a turnover. Assigning one to a crew member instead of a vendor is how you hand your own people a one-off job:

- A seasonal project: pressure wash the deck before Memorial Day, blow out the irrigation before the first freeze.
- A deep clean that is not part of a changeover: the garage, the grill, the inside of the oven.
- Prep work: staging a property before an owner visit or a photographer.

Create it the same way as any other work order, choose **Internal Crew** on the assignee toggle, and pick the person. It appears in their crew app alongside their turnovers, and they complete it there, offline if they have no signal. Give it a Completed By date if the timing matters.

---

## Special Projects (from the property page)

There is a shortcut for this on the property itself. Open a property, find the **Maintenance** card, and click **New Special Project**.

It asks five things and nothing else:

- **What needs doing** — the title, e.g. "Pressure wash the deck before Memorial Day"
- **Assign to** — one of your crew members, or leave it unassigned for now
- **Needed by** — optional date
- **Priority** — Low, Medium, High, or Urgent
- **Category** — defaults to General, and you can change it if one of the others fits better
- **Notes** — access, supplies, anything they need to know

The property is already filled in, and there is no vendor option: a special project is work for your own crew. For a job that needs an outside contractor, use **Maintenance → New Work Order** instead.

**A special project is a work order.** The shorter form is the only difference. It gets a work order number, it shows up on this property and on the Maintenance board, the crew member completes it in the crew app the same way, and its cost posts to the owner ledger like any other. So you can find it, reassign it, cancel it, or attach photos to it wherever you would do that for a work order.

## Does FieldStay pick the crew member for a special project?

No. You pick, every time.

FieldStay's crew scorer suggests people for **turnovers**, where it has a checkout time, a drive distance and a reliability history to weigh. Work orders are not scored that way, and nothing in FieldStay assigns a work order to a crew member on its own.

There is one place a work order arrives with a crew member suggested on it: a cleaning job created automatically from a failed inspection, where FieldStay suggests whoever last cleaned that property. That is a suggestion you accept or override on the Maintenance board, not an assignment. A special project you create yourself never carries one.

Leaving **Assign to** blank is a normal thing to do. The project is created unassigned and waits on the Maintenance board until you give it to someone.

## The Vendor Dispatch Email

When you assign a vendor, FieldStay sends them a dispatch email containing:
- Property address and scheduled date
- Full work order description
- NTE amount if set
- A secure link to their vendor portal

The vendor portal link allows the vendor to review the order and submit their completion details without needing a FieldStay account. The link is unique to this work order and expires after 30 days.

If you later assign a different vendor, or assign a vendor to a work order that was initially created without one, a new dispatch email goes out automatically.

---

## Vendor Compliance

Before a work order can be dispatched to a vendor, FieldStay checks their compliance status:

- **Compliant** — valid COI and licenses on file, dispatch proceeds normally
- **Expiring Soon** — COI expires within 30 days, you'll see a warning but can still dispatch
- **Grace Period** — COI has expired 1–45 days ago, requires acknowledgment before dispatch
- **Hard Blocked** — COI expired 46+ days ago, vendor cannot be assigned until documents are updated

Add and manage vendor compliance documents under **Vendors → [Vendor Name] → Compliance**.

---

## Tracking Work Order Status

| Status | Meaning |
|---|---|
| Pending | Created, no vendor or crew assigned |
| Assigned | Dispatched to vendor or assigned to crew |
| In Progress | Vendor or crew has started |
| Completed | Signed off or marked complete |
| Cancelled | Voided — no cost posted |

---

## How Completion Works

**Vendor path:** The vendor submits their completion details through the portal — line items, notes, and a photo — and signs off. Signing off completes the work order immediately and posts the actual cost to the owner financial ledger automatically; there's no separate PM approval step to review before that happens. You receive a notification once it's done.

**Crew path:** The crew member taps Mark Complete in their app, optionally adds notes, and you receive an email notification. The work order moves to Completed status.

---

## Connecting Work Orders to Assets

If the work is on a tracked asset (HVAC unit, appliance, water heater), you can link the work order to that asset. This builds a repair history that feeds into the asset's health score and capital planning projections. Select the asset from the **Asset** dropdown when creating or editing the work order.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
