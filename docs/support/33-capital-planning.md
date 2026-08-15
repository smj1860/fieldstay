# Capital Planning

**Capital Planning turns your asset data into a 10-year replacement budget — plus tools to sanity-check that budget against inflation and against delaying a purchase.** It's the planning view that sits on top of Asset Health; if Asset Health tells you the condition of what you own, Capital Planning tells you what that condition means for your wallet over time.

This is included on every plan at no extra cost, same as Asset Health tracking.

---

## Where to Find It

Go to **Capital Planning** in the sidebar (Portfolio section). It's visible to Admins and Managers. If you're looking at a single property's assets, there's also a **← Assets** link back to the Assets page from the top of Capital Planning.

If you manage more than one property, a property filter at the top narrows every section on the page to just that property — the 10-year forecast, the reserve fund number, and the What-If panel all recalculate for the filtered set.

---

## Depreciation Ledger

A card at the top shows last year's MACRS depreciation total and how many assets were included, with an **Export PDF** link once a ledger has been generated for your CPA. Click **Generate [Year] Ledger** to run it for the first time or to refresh it. See **Asset Health Tracking and Depreciation** for how individual assets get their MACRS class and depreciation schedule.

---

## Upcoming in 12–24 Months

When any asset is forecast to need replacement in the current or next calendar year, a card highlights those items with their combined estimated cost range and current status (see Replacement Status below). This is the "what do I need to budget for soon" view — everything else on the page is either historical (the ledger) or longer-range (the 10-year forecast).

---

## Repair vs. Replace Signals

Separately from the age-based 10-year forecast, FieldStay watches each asset's recent repair spending and flags ones where fixing it is starting to look like a worse deal than replacing it. An asset is flagged when either:

- Its repair costs in the trailing 12 months (plus an estimate of lost booking revenue if the repair kept the property offline for a while) reach roughly half of its estimated replacement cost, or
- Repair costs are trending sharply upward year over year while its health score is already below "Good."

Because this is driven by actual repair history rather than age, an asset can show up here well before it would age into the 10-year forecast below — a newer unit with a rough repair history can flag sooner than an older one that's held up well. Each flagged item shows the reasoning FieldStay used, so you can see exactly why it was surfaced.

---

## Reserve Fund Recommendation

Once a 10-year forecast exists, FieldStay divides the total projected replacement cost by 120 months to suggest a flat monthly reserve amount — a simple straight-line savings target so a big replacement year doesn't have to come out of one month's cash flow. This is a planning aid, not a guarantee of actual future costs.

---

## What-If: Inflation & Deferral

This panel lets you stress-test the 10-year forecast two ways:

- **Annual inflation rate** — projects future replacement costs in real dollars instead of assuming a water heater costs the same in year 8 as it does today. Defaults to your organization's saved rate (4% out of the box) but you can adjust it per scenario. Click **Save as org default** to make an adjusted rate stick for future visits to this page.
- **Defer replacements by** — recalculates the 10-year total as if every upcoming replacement were pushed back by the same number of months (0 to 36), so you can see the real-dollar cost of "let's wait" once inflation compounds onto the delayed purchase.

The panel shows the on-schedule total next to the deferred total so you can compare them directly, plus a one-line summary of whether deferring costs more or less in this scenario.

---

## The 10-Year Replacement Forecast

A bar chart shows the total estimated replacement cost per year across the next decade, color-coded by size (green under $5k, amber $5k–$15k, red over $15k). Below it, each year with upcoming replacements is broken out into a card listing the specific assets, their age and percentage of expected lifespan, health score, and estimated cost range.

Click **Generate Projections** to (re)build the forecast — it only needs to be run again after adding or editing assets in a way that changes the picture; it isn't fully automatic. Only assets with an installation date are included, since that's what the forecast is built from.

### Replacement Status

Each item in the forecast has a status you can set from a dropdown: **Projected** (the default — FieldStay's estimate, no action taken), **Budgeted**, **Approved**, or **Deferred**. This is for your own tracking — recording where a planned replacement actually stands in your budgeting process — and doesn't change the forecast math itself.

### Exporting

Use **Export CSV** at the bottom of the page to download the current year's forecast for use outside FieldStay (a budget spreadsheet, an owner conversation, etc.).

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
