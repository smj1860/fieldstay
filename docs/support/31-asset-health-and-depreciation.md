# Asset Health Tracking and Depreciation

**FieldStay tracks the condition of the big-ticket items in each property — HVAC, water heater, roof, appliances, and more — and turns that into a 0–100 health score, a replacement budget, and (for the numbers-minded) MACRS tax depreciation schedules.**

This is included on every plan at no extra cost — there's no separate add-on or unlock condition, unlike the Guest Guidebook.

---

## Where to Find It

Go to **Assets** (top-level nav). There are two views:

- **By Property** — a card per property showing its asset count and a "needs attention" flag if anything is in Poor or End of Life condition. Click **View Assets** to see the full list for that property.
- **Portfolio** — a rollup across every property, useful for planning capital spending across your whole operation rather than one property at a time.

---

## Adding an Asset

From a property's asset view, click **Add Asset** and fill in:

- **Asset type** — HVAC, water heater, roof, refrigerator, washer, dryer, dishwasher, and about two dozen others (full list under **Maintenance → New Work Order → Asset** as well, since work orders can link to assets)
- **Name** — something identifiable, e.g. "Main HVAC Unit" or "Master Bath Water Heater"
- **Make / model / serial number**
- **Installation date** — this doubles as the tax placed-in-service date (see Depreciation below)
- **Purchase price** and **estimated replacement cost**
- **Warranty expiry date** and **warranty provider**

### Scan Data Plate (mobile)

On a phone, there's a **Scan Data Plate** button that lets you photograph an appliance's data plate/nameplate — FieldStay reads the make, model, serial number, and manufacture year off the photo and pre-fills the form. Low-confidence reads are flagged so you can double-check before saving; you can always fix any field by hand.

### Bulk Import

If you already track assets in a spreadsheet, use **Import** (CSV) instead of adding them one at a time. The expected columns are: `name, asset_type, make, model, serial_number, installation_date, purchase_price, estimated_replacement_cost, warranty_expiry_date, warranty_provider, notes`.

### Assets Discovered from Turnovers

Some turnover checklist items are "discovery tasks" — things like photographing an appliance's data plate during a cleaning. Those photos and details feed directly into the asset record for that property, so assets can show up automatically as your crew works through turnovers, not just from what you enter manually.

---

## Understanding the Health Score

Every asset with an installation date gets a health score from 0–100, shown as a colored pill next to the asset:

| Score | Label |
|---|---|
| 80–100 | Good |
| 60–79 | Fair |
| 40–59 | Aging |
| 20–39 | Poor |
| 0–19 | End of Life |

The score is calculated from the asset's age relative to its expected lifespan for that asset type, and adjusted based on its actual repair history (work orders logged against it) — an asset with a heavier repair history scores lower than an identical-age asset with a clean record. Scores recalculate automatically as time passes and as new work orders are linked to the asset; there's nothing to trigger manually.

The age portion of the score doesn't decline in a straight line — it holds up for most of an asset's expected life and then falls off faster as it nears the end of that range, closer to how equipment actually tends to wear out. FieldStay periodically refines this curve per asset type using real replacement data collected across the platform (see Replacing an Asset below), so scoring gets more accurate for a given asset type over time as more of that data accumulates.

An asset with no installation date on file shows as **Unknown** rather than a score, since there's nothing to calculate age from.

Assets in Poor or End of Life condition are flagged with a warning banner on the property's asset view, and count toward the "needs attention" badge shown on the Assets page and property card.

---

## Depreciation and Tax Reporting

If you enter a **purchase price** and **installation date** (used as the placed-in-service date), FieldStay generates an annual MACRS depreciation schedule for that asset. Asset types are pre-mapped to the correct MACRS class:

- **5-Year MACRS** — most appliances and equipment
- **15-Year MACRS** — certain land-improvement-adjacent assets
- **27.5-Year Straight-Line** — residential rental property components
- **39-Year Straight-Line** — nonresidential real property components
- **Section 179** — assets eligible for full first-year deduction

When a 5-year MACRS asset is placed in service in the current tax year, you'll see a **Section 179 eligible** badge on the asset — a reminder to talk to your CPA about the immediate-deduction option, not a guarantee that it applies to your specific tax situation.

**FieldStay's depreciation schedules are a planning aid, not tax advice.** They're built from the standard IRS half-year-convention tables, but your actual filing should go through your accountant or tax preparer.

---

## Replacement Budgeting

Because every asset has an estimated replacement cost and a health score, the Portfolio view lets you see, at a glance, how much capital spending is coming across your whole portfolio in the near term. For the full 10-year forecast, a reserve-fund savings target, inflation-adjusted projections, and repair-vs-replace recommendations based on actual repair spend, see **Capital Planning**.

---

## Replacing an Asset

When an asset actually gets swapped out — not just removed, but replaced with a new unit — click the **Replace** button (the circular arrows icon) on its row instead of adding a new asset separately and deactivating the old one by hand. This opens the same form as adding a new asset, but on save it does two things together automatically:

- Creates the new asset record with the details you entered
- Marks the old asset replaced and inactive, and links the two records together

Doing this as one step (rather than adding a new asset and separately deactivating the old one) is what lets FieldStay capture how old an asset actually was when it was replaced — which is also the real-world data referenced above that improves health scoring for that asset type over time.

---

## Warranty Alerts

If you've entered a **warranty expiry date** on an asset, FieldStay checks daily for warranties expiring within the next 30 days and sends a one-time notification (via the bell icon) when one crosses into that window, naming the asset and its warranty provider so you know before coverage lapses. You won't get a second alert for the same warranty once it's fired.

---

## Removing an Asset

If an asset is being retired without a direct replacement — removed from service rather than swapped for a new unit — click the **X** on its row to deactivate it rather than deleting your history. Deactivated assets stop showing up in health tracking but the record (and its depreciation history, if any) is preserved. If the asset IS being swapped for a new one, use **Replacing an Asset** above instead — it keeps the age-at-replacement data FieldStay uses to improve scoring, which a plain deactivate-then-add-new does not.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
