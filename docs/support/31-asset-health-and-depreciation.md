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

Because every asset has an estimated replacement cost and a health score, the Portfolio view lets you see, at a glance, how much capital spending is coming across your whole portfolio in the near term — useful when budgeting for next year or having a conversation with an owner about an upcoming replacement.

---

## Removing an Asset

If an asset is replaced or removed from a property, click the **X** on its row to deactivate it rather than deleting your history — deactivated assets stop showing up in health tracking but the record (and its depreciation history, if any) is preserved.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
