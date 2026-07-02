# Setting Up Templates, Checklists, and Scheduled Maintenance

Getting your templates and schedules right in the first week pays dividends every single turnover after. These are the master configurations that drive everything else — your crew's checklist, your inventory counts, your maintenance reminders.

---

## Inventory Templates — Set Once, Apply Everywhere

An inventory template is a reusable list of supplies you track across your properties — paper towels, dish soap, trash bags, toiletries, coffee pods, cleaning products. You build one template (or a few for different property types) and apply it to multiple properties at once.

**Why this matters:** When you apply a template to a property, FieldStay creates individual par-level targets for every item at that property. Your crew counts against those targets during each turnover. Items below par trigger a restock order automatically. Getting the template right means the restocking engine works without you touching it.

### Building a Template

Go to **Inventory → Templates → New Template** and add each item you track:

- **Item name** — be specific. "Paper Towels" is fine. "6-pack Bounty Select-A-Size" is better, especially if you use the Kroger cart integration.
- **Unit** — how you count it. Rolls, packs, bottles, bars. Your crew counts in this unit, and the restock order orders in this unit. Be consistent.
- **Par level** — the minimum quantity before reordering triggers. Start with what you'd feel comfortable having on hand for a last-minute same-day flip. You can always adjust later.
- **Preferred brand** — optional, but recommended if you use Kroger. FieldStay searches for this brand first when building your cart.

### Applying to Properties

Click **Apply to Property** and select the properties where this template applies. After applying, go to **Inventory → [Property Name]** to review and adjust par levels per property — a 6-bedroom property needs higher par levels than a 1-bedroom.

**Templates are a starting point, not a lock.** Once applied, each property's item levels are independent. Changing the template later does not automatically update already-applied properties — it creates new items for future applications.

---

## Turnover Checklists — Your Standard, Their Checklist

Every turnover in FieldStay comes with a checklist your crew works through on their app. The master checklist lives under **Settings → Checklist Template** and is the default applied to new turnovers.

### What's Already There

FieldStay seeds a comprehensive default checklist covering the standard sections for STR turnover: arrival inspection, kitchen, bathrooms, bedrooms, living areas, outdoor spaces, restocking, and final checks. Most PMs find it covers 80-90% of what they need out of the box.

### Customizing for Your Operation

You can add, edit, or remove items to match exactly what you expect from your crew:

- **Add items** that are specific to your properties — a hot tub inspection step, a specific appliance check, a guest welcome setup task
- **Remove items** that don't apply — not every property has a fireplace or a pool
- **Reorder sections** to match the flow your crew naturally works in

Crew members can check items off in any order, but presenting the checklist in a logical room-by-room flow reduces the chance something gets skipped.

### Discovery Tasks

Some checklist items are marked as discovery tasks — things like "note any damage" or "photograph appliance stickers." These are non-deletable by design at the data level, not just hidden in the UI. They exist because the information they capture (damage photos, asset data) feeds into other parts of the platform.

---

## Scheduled Maintenance — Set the Frequency, FieldStay Handles the Rest

Maintenance schedules are recurring tasks that automatically create work orders when a due date is reached — HVAC filter changes, pest control, gutter cleaning, fire extinguisher inspections, and similar periodic tasks.

Go to **Maintenance → Schedules → New Schedule** and configure:

### Frequency

How often the task recurs. Common options:
- Monthly (pest control, filter checks)
- Quarterly (HVAC service, deep clean)
- Semi-annually (gutter cleaning, smoke detector tests)
- Annually (fire extinguisher inspection, roof inspection)

**Set this carefully.** FieldStay uses the frequency to calculate the next due date after each completion. A quarterly task completed on March 1 will next appear on June 1. If you set it as monthly by accident, you'll get a work order every month instead.

### Next Due Date

This is the most important field to get right during setup. Set it to when the task is actually next due — not today, not the last time it was done, but the actual next occurrence.

**Example:** If you had the HVAC serviced in February and you do it every 6 months, set next due date to August, not today.

If you're not sure when something was last done at a property, a quick walkthrough or a call to your previous vendor will tell you.

### Vendor Assignment

You can link a scheduled maintenance item to a specific vendor. When the work order generates, that vendor receives the dispatch email automatically. Vendor compliance is checked before dispatch — if their COI is expired, the assignment is flagged.

---

## Quick Setup Checklist

Before your first real turnover runs through FieldStay:

- [ ] Inventory template created with all items you track
- [ ] Par levels set per property (adjust defaults up for larger properties)
- [ ] Turnover checklist reviewed — add property-specific items, remove anything that doesn't apply
- [ ] Scheduled maintenance items entered with correct frequencies and realistic next due dates
- [ ] At least one vendor assigned to recurring maintenance tasks they handle

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
