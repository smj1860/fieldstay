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

## The Vendor Dispatch Email

When you assign a vendor, FieldStay sends them a dispatch email containing:
- Property address and scheduled date
- Full work order description
- NTE amount if set
- A secure link to their vendor portal

The vendor portal link allows the vendor to review the order and submit their completion details without needing a FieldStay account. The link is unique to this work order and expires after 90 days.

If you later assign a different vendor, or assign a vendor to a work order that was initially created without one, a new dispatch email goes out automatically.

---

## Vendor Compliance

Before a work order can be dispatched to a vendor, FieldStay checks their compliance status:

- **Compliant** — valid COI and licenses on file, dispatch proceeds normally
- **Expiring Soon** — COI expires within 30 days, you'll see a warning but can still dispatch
- **Grace Period** — COI has expired 1–30 days ago, requires acknowledgment before dispatch
- **Hard Blocked** — COI expired 31+ days ago, vendor cannot be assigned until documents are updated

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

**Vendor path:** The vendor submits their completion details through the portal — line items, notes, and a photo. Once submitted, you receive a notification to review and approve. Approving the work order posts the actual cost to the owner financial ledger automatically.

**Crew path:** The crew member taps Mark Complete in their app, optionally adds notes, and you receive an email notification. The work order moves to Completed status.

---

## Connecting Work Orders to Assets

If the work is on a tracked asset (HVAC unit, appliance, water heater), you can link the work order to that asset. This builds a repair history that feeds into the asset's health score and capital planning projections. Select the asset from the **Asset** dropdown when creating or editing the work order.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
