# Inventory Templates and the Kroger Cart

**Inventory templates define what supplies you track at each property, and the Kroger integration turns below-par counts into a ready-to-order shopping cart with one click.**

---

## What Is an Inventory Template

A template is a reusable list of supply items — paper towels, dish soap, trash bags, toiletries — with par levels and preferred brands. You create one template (or a few for different property types) and apply it to multiple properties.

This means you only set up the list once. When you apply a template to a new property, all the items and par levels copy over automatically.

---

## Creating a Template

Go to **Inventory → Templates → New Template** and:

1. Give the template a name (e.g. "Standard Cabin" or "Luxury Beachfront")
2. Add items one by one — name, unit of measure, par level, and preferred brand
3. Save the template

**Units matter.** Be specific about how items are counted — rolls vs packs, single vs case. Your crew counts against these units during each turnover, and the Kroger cart orders in the same unit.

**Preferred brand** is optional but recommended for Kroger integration. When a brand is specified, FieldStay searches Kroger for that brand first. Without a brand, Kroger returns the default product which may not match what you actually want.

---

## Applying a Template to a Property

Go to **Inventory → Templates**, find your template, and click **Apply to Property**. Select the properties where this template applies.

After applying, go to **Inventory → [Property Name]** to review and adjust par levels per property. A 6-bedroom property may need higher par levels than a 2-bedroom. Adjust individual items without changing the template — template changes don't automatically push to already-applied properties.

---

## Connecting Kroger

To enable automatic cart building, connect your Kroger account:

1. Go to **Settings → Integrations → Kroger**
2. Click **Connect Kroger Account**
3. Authorize FieldStay in Kroger
4. FieldStay automatically finds and connects your nearest Kroger-owned
   store based on your first property's address — no selection needed.
   You'll see the store name under Settings → Integrations → Kroger once
   it's set.

Kroger authorization lasts approximately 6 months. FieldStay will prompt you to reconnect if the token expires.

---

## Don't Live Near a "Kroger"?

Kroger owns dozens of regional grocery chains under different names — if
there's no store literally called "Kroger" near your property, you likely
still have one nearby under a different banner. FieldStay automatically
connects to whichever Kroger-owned store is closest, including:

Ralphs · Fred Meyer · King Soopers · Smith's · Fry's · QFC · City Market ·
Dillons · Baker's · Gerbes · Harris Teeter · Mariano's · Pick 'n Save ·
Metro Market · Food 4 Less · Foods Co

If one of these is near your property, the Kroger connection will find it
automatically — no separate setup required.

---

## How the Cart Builds

When an inventory count comes in with items below par, FieldStay:

1. Identifies all below-par items across all properties with counts submitted that day
2. Calculates the quantity needed to reach par (par level minus current count)
3. Searches Kroger for each item using the preferred brand if set
4. Adds the correct quantity to your Kroger cart

You receive an email with the full restock list. The email includes a link directly to your Kroger cart where the items are already loaded — you review and checkout.

**You always approve before ordering.** FieldStay builds the cart and notifies you. The purchase only happens when you complete checkout in Kroger.

---

## Same-Day Flip Exception

If a property has a guest checking out and a new guest checking in on the same day, the inventory restock notification fires immediately after the count is submitted rather than waiting for end of day. Items needed for a same-day flip can't wait.

---

## Reviewing and Adjusting the Cart

Open the Kroger cart link from your email. From there you can:
- Remove items you don't need
- Adjust quantities
- Swap brands
- Add items Kroger couldn't find automatically

This is also where you apply any Kroger coupons or loyalty discounts before checkout.

---

## Troubleshooting

If something isn't syncing or showing up the way you expect, use **Trigger
Resync** next to Kroger in Settings → Integrations first. If that doesn't
fix it, disconnect and reconnect.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
