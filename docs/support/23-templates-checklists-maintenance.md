# Setting Up Templates, Checklists, and Scheduled Maintenance

Getting your templates and schedules right in the first week pays dividends every single turnover after. These are the master configurations that drive everything else — your crew's checklist, your inventory counts, your maintenance reminders.

All three live under **Templates** in the main nav (`/templates`) — a hub with three tiles: Turnover Checklist, Inventory, and Scheduled Maintenance. Each is portfolio-wide configuration: build once, reuse across every property.

---

## Turnover Checklist — Room Library Builder

Go to **Templates → Turnover Checklist**. This is the Room Library Builder: an org-wide library of rooms (Kitchen, Bathroom, Primary Bedroom, Outdoor Space, and so on), each with its own checklist items. Build the library once, then apply rooms to whichever properties need them.

### What's Already There

FieldStay seeds a starting room library covering standard STR turnover sections. Most PMs find it covers 80-90% of what they need out of the box.

### Customizing for Your Operation

- **Add rooms** specific to your properties — a hot tub, a specific appliance, a guest welcome setup step
- **Edit or remove items** within a room that don't apply — not every property has a fireplace or a pool
- **Apply rooms to properties** from the builder — a property only gets the checklist sections for the rooms you've applied to it, so a studio and a 6-bedroom house can use very different room sets from the same shared library

Seeded/system rooms are editable (you can change their items) but not deletable — that protects the default library from being emptied out by accident, while still letting you tailor the content.

### Discovery Tasks

Some checklist items are marked as discovery tasks — things like "note any damage" or "photograph appliance stickers." These are non-deletable by design at the data level, not just hidden in the UI. They exist because the information they capture (damage photos, asset data) feeds into other parts of the platform.

---

## Inventory — Catalog, Par Levels, and Named Templates

Go to **Templates → Inventory**. There are a few connected screens here:

- **Master List** (`Templates → Inventory → Master List`) — your org's own editable copy of the supply catalog (paper towels, dish soap, trash bags, toiletries, coffee pods, cleaning products, and so on). Seeded from FieldStay's platform catalog on first use, then fully yours to edit.
- **Par Levels** (`Templates → Inventory → Par Levels`) — set default par-level targets per item, applied across your properties.
- **Create / Saved Templates** (`Templates → Inventory → Create` / `Saved`) — you can build more than one named template (e.g. one for smaller units, one for larger houses) and apply whichever one fits a given property.

**Why this matters:** Items below par trigger a restock order automatically. Getting the catalog and par levels right means the restocking engine works without you touching it.

- **Item name** — be specific. "Paper Towels" is fine. "6-pack Bounty Select-A-Size" is better, especially if you use the Kroger cart integration.
- **Unit** — how you count it. Rolls, packs, bottles, bars. Your crew counts in this unit, and the restock order orders in this unit. Be consistent.
- **Preferred brand** — optional, but recommended if you use Kroger. FieldStay searches for this brand first when building your cart. You can set a preferred brand at the template level, and override it per property.

**Templates are a starting point, not a lock.** Once applied to a property, that property's item levels are independent — changing a template later doesn't retroactively update properties it was already applied to.

---

## Scheduled Maintenance — Catalog and Per-Property Schedules

Go to **Templates → Scheduled Maintenance**. Like Inventory, this has a catalog layer and a per-property layer:

- **Create** (`Templates → Scheduled Maintenance → Create`) — your org's catalog of recurring maintenance task types (HVAC filter changes, pest control, gutter cleaning, fire extinguisher inspections, and similar periodic tasks), seeded from the platform catalog.
- **Saved Templates** — reusable named sets of maintenance items, the same idea as Inventory's saved templates.
- **Schedules** (`Templates → Scheduled Maintenance → Schedules`) — the actual per-property recurring schedules, each with a frequency, next due date, and optional vendor assignment. This is where a catalog item becomes a real recurring task that creates work orders automatically.

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

- [ ] Turnover Checklist room library reviewed and applied to your properties — add property-specific rooms, remove anything that doesn't apply
- [ ] Inventory master list and par levels set (adjust defaults up for larger properties)
- [ ] Scheduled maintenance items entered with correct frequencies and realistic next due dates
- [ ] At least one vendor assigned to recurring maintenance tasks they handle

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
