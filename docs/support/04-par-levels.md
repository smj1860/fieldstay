# What Is a Par Level and How Do I Set One

Par levels tell FieldStay the minimum quantity of each supply item that needs to
be on hand before triggering a restock order.

## The Simple Version
A par level answers: what is the least amount of this item I can have before
needing to order more? If you always want at least 4 rolls of paper towels, the
par level for paper towels is 4.

## Most Par Levels Set Themselves
You do not have to work out a number for every item at every property. Most
items scale automatically with the size of the property:

- **Bathroom items** — bath towels, washcloths, bath mats, toiletries, hair
  dryer — scale with the number of **bathrooms**
- **Bedroom items** — hangers, spare pillows, extra linens, luggage racks —
  scale with the number of **bedrooms**
- **Guest consumables** — coffee, creamer, dinnerware, drinking glasses —
  scale with **how many guests the property sleeps**

Each includes a small safety buffer so a busy week does not empty a shelf. This
is why the same item shows a different quantity at a 1-bathroom condo than at a
4-bathroom lodge — that is working as intended, not a mistake.

Some items do not vary with size at all — a plunger, a toilet brush, a first aid
kit. Those stay a fixed quantity at every property.

## Why Par Levels Matter
Your crew's inventory count is used to fill an actual shopping cart or generate
a purchase order. An inaccurate par level means over-ordering (waste) or
under-ordering (empty shelves at guest arrival).

## Setting Up a Property
1. Every new property is stocked from the FieldStay standard list automatically
   when you create it — you do not need to apply a template first
2. Add anything else that property needs (pool towels, fire pit supplies, a hot
   tub kit) at **Inventory → [Property Name]**. Items added from the catalog
   scale with property size the same way the standard ones do
3. Make sure the property's **bedrooms, bathrooms and max guests** are filled in
   under **Properties → [Property Name] → Details**. Those three numbers are
   what everything scales from, so a blank or wrong value there is the most
   common reason a par level looks off

## Changing a Par Level Yourself
Click the par level at **Inventory → [Property Name]** and type the number you
want.

Your number is used exactly as typed. The item then keeps scaling from *your*
number instead of the FieldStay default — so if you set washcloths to 16 at a
2-bathroom property and later add a third bathroom, it moves to 24 rather than
back to what it was. It also stops adjusting itself from usage data, because you
have told it what you want.

Setting a par level to **0** marks the item as one you do not stock at that
property. It stays at 0 and never scales.

## Why a Par Level Changed On Its Own
Two things move a par level without you touching it, both expected:

- **You edited the property.** Changing bedrooms, bathrooms or max guests
  rescales every item that scales with that number, within a few seconds.
- **FieldStay learned from your counts.** Once a property has enough inventory
  counts on record, the system starts using what that property actually goes
  through instead of the size-based estimate.

Neither one touches a level you set yourself, or an item marked as a fixed
quantity.

## Still Not Sure Why a Number Is What It Is
Ask the in-app support chat: *"why is my washcloth par level what it is?"* It
will explain that specific item at that specific property — what it scales with,
what the property's current count is, whether you set it yourself, and what to
change to move it.

## What Happens Below Par
When a count falls below par, FieldStay creates a purchase order automatically.
An end-of-day email lists all below-par items across all properties. If Kroger
is connected, you can then go to **Inventory → Portfolio** and click
**Build Cart** to add every below-par item across your properties to your
Kroger cart — this is a manual step you trigger, not something that happens
on its own.

Same-day flip exception: if a property has a checkout and check-in on the same day,
the order email fires immediately instead of waiting for end of day.

## Crew Feedback on Par Levels
Crew can add notes in the inventory count if a par level seems wrong. Update the
level at **Inventory → [Property Name] → [Item]**. Takes effect on the next count.
