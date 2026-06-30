# Vendor Compliance Documents

**FieldStay tracks vendor certificates of insurance, licenses, and bonding documents — and automatically blocks work order assignments when documents expire.**

---

## Why Compliance Tracking Matters

Assigning a work order to a vendor without a valid COI exposes you and your property owners to liability if an incident occurs on site. FieldStay's compliance gate prevents accidental assignment to expired vendors before a job is dispatched.

---

## Adding a Compliance Document

Go to **Vendors → [Vendor Name] → Compliance** and click **Add Document**.

Fill in:
- **Document type** — Certificate of Insurance, General Liability, Workers Comp, Business License, Bonding, or Other
- **Expiration date** — FieldStay tracks this and alerts you before it expires
- **Upload the document** — PDF or image file

The document is stored securely and not shared with anyone outside your organization.

---

## The Compliance Status System

Every vendor has a compliance status based on their document expiration dates:

| Status | Meaning | What Happens |
|---|---|---|
| Compliant | All documents valid | Work orders dispatch normally |
| Expiring Soon | A document expires within 30 days | Warning shown, dispatch still allowed |
| Grace Period | A document expired 1–30 days ago | Requires your acknowledgment before dispatch |
| Hard Blocked | A document expired 31+ days ago | Cannot be assigned to work orders |

---

## Grace Period Acknowledgment

When a vendor enters the Grace Period, FieldStay shows a warning modal when you try to assign them to a work order. You can acknowledge the risk and proceed, but the acknowledgment is logged with a timestamp.

This gives you flexibility for trusted vendors while maintaining an audit trail.

---

## Expiry Notifications

FieldStay sends email notifications at:
- 30 days before expiration
- 14 days before expiration
- 7 days before expiration
- On the expiration date
- 14 days after expiration
- 30 days after expiration (vendor moves to Hard Blocked at 31 days)

Both you and the vendor receive these notifications so they can take action on their end.

---

## Updating an Expired Document

When a vendor renews their COI or license, go to **Vendors → [Vendor Name] → Compliance**, find the expired document, and click **Update**. Upload the new document and enter the new expiration date.

The vendor's compliance status updates immediately — if they were Grace Period or Hard Blocked, they return to Compliant once a valid document is on file.

---

## Vendor Distance and Assignment

When assigning a vendor to a work order, FieldStay shows the distance from the vendor's service address to the property. This helps you choose between multiple compliant vendors for a job based on proximity.

Add the vendor's service address under **Vendors → [Vendor Name] → Details**.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
