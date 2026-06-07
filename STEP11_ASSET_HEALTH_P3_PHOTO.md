# Step 11 Pre-Brief: Asset Health — Pillar 3 + Photo Scanning
# CapEx & Depreciation Hub + Data Plate OCR
# Items: 8.1, 8.3, 8.16, 8.17, 8.18, 8.19, 8.20

---

## Prerequisites — Step 10 Must Be Complete

Step 11 requires:
- `property_assets` data populated (from 8.2 asset entry form)
- `asset_depreciation_entries` table (schema already applied)
- `PropertyAsset` and `AssetTypeStandard` types from Step 10

---

## types/database.ts — Add Before Writing Any Functions

```typescript
export interface AssetDepreciationEntry {
  id:                            string
  org_id:                        string
  asset_id:                      string
  tax_year:                      number
  macrs_class:                   MacrsClass
  cost_basis:                    number
  prior_cumulative_depreciation: number
  current_year_depreciation:     number
  ending_adjusted_basis:         number
  depreciation_rate:             number | null
  notes:                         string | null
  generated_at:                  string
}
```

---

## MACRS Depreciation Rate Tables — Use These Exactly

```typescript
// IRS Publication 946 — half-year convention
// Source: Table A-1 (200% DB) and Table A-1 (150% DB)

const MACRS_RATES: Record<MacrsClass, number[]> = {
  '5_year': [0.2000, 0.3200, 0.1920, 0.1152, 0.1152, 0.0576],
  '15_year': [0.0500, 0.0950, 0.0855, 0.0770, 0.0693, 0.0623,
              0.0590, 0.0590, 0.0590, 0.0590, 0.0590, 0.0590,
              0.0590, 0.0590, 0.0590, 0.0295],
  '27_5_year': [],   // straight-line: 1/27.5 = 0.03636 per year
  '39_year':   [],   // straight-line: 1/39 = 0.02564 per year
  'section_179': [], // full cost deducted year 1
}

function getMacrsRate(macrsClass: MacrsClass, yearOfService: number): number {
  if (macrsClass === 'section_179') return yearOfService === 1 ? 1.0 : 0
  if (macrsClass === '27_5_year')   return 1 / 27.5
  if (macrsClass === '39_year')     return 1 / 39

  const rates = MACRS_RATES[macrsClass]
  if (yearOfService < 1 || yearOfService > rates.length) return 0
  return rates[yearOfService - 1]
}

function calculateAnnualDepreciation(
  asset:   PropertyAsset,
  taxYear: number,
): AssetDepreciationEntry | null {
  if (!asset.placed_in_service_date || !asset.purchase_price) return null

  const serviceYear  = new Date(asset.placed_in_service_date).getFullYear()
  const yearOfService = taxYear - serviceYear + 1  // year 1 = first year in service

  if (yearOfService < 1) return null  // not yet in service

  const rate         = getMacrsRate(asset.macrs_class, yearOfService)
  const costBasis    = asset.purchase_price - (asset.salvage_value ?? 0)
  const priorDepr    = getPriorCumulativeDepreciation(asset.id, taxYear)  // query DB
  const currentDepr  = Math.round(costBasis * rate * 100) / 100
  const endingBasis  = Math.max(0, costBasis - priorDepr - currentDepr)

  return {
    id:                            crypto.randomUUID(),
    org_id:                        asset.org_id,
    asset_id:                      asset.id,
    tax_year:                      taxYear,
    macrs_class:                   asset.macrs_class,
    cost_basis:                    costBasis,
    prior_cumulative_depreciation: priorDepr,
    current_year_depreciation:     currentDepr,
    ending_adjusted_basis:         endingBasis,
    depreciation_rate:             rate,
    notes:                         null,
    generated_at:                  new Date().toISOString(),
  }
}
```

---

## Build Order for This Step

### 1 — Monthly CapEx projection cron (8.16)

Add to `events.ts`:
```typescript
'asset/capex-projection-generated': {
  data: { org_id: string; tax_year: number }
}
```

New Inngest function `generate-capex-projections` triggered by a monthly cron
(`0 0 1 * *` — 1st of each month at midnight UTC).

For each org, for each active `property_asset` with `installation_date`:

```typescript
const ageYears     = currentYear - new Date(asset.installation_date).getFullYear()
const lifespan     = asset.expected_lifespan_years ?? avgLifespan(standards)
const yearsLeft    = lifespan - ageYears
const replCost     = asset.estimated_replacement_cost
                     ?? standards.avg_replacement_cost_high
                     ?? null

if (replCost && yearsLeft <= 10) {
  // Bucket into replacement year
  const replacementYear = currentYear + Math.max(0, Math.ceil(yearsLeft))
  // Add to projection for that year
}
```

Store result in `org_milestones` with key `capex_projection_{year}`:
```typescript
{
  generated_at: string
  projections: {
    [year: number]: {
      total_low:  number
      total_high: number
      items: {
        asset_id:        string
        asset_name:      string
        property_name:   string
        asset_type:      string
        replacement_year: number
        cost_low:        number
        cost_high:       number
        health_score:    number | null
        age_years:       number
        pct_of_lifespan: number
      }[]
    }
  }
}
```

### 2 — CapEx forecast UI (8.17)

New page or tab in the dashboard: "Capital Planning" or within Asset Health dashboard.

Shows a 3-year forecast by default with tabs for 5-year and 10-year.

**Summary bar chart:** X-axis = years (2026, 2027, 2028...), Y-axis = projected cost.
Each bar represents the estimated replacement spend for that year.
Bar color: green (< $5k), amber ($5k–$15k), red (> $15k).

**Itemized list below the chart:** grouped by year.
Each item shows:
- Property name
- Asset name and type
- Age / expected lifespan (e.g. "12 of 15 years — 80%")
- Health score pill
- Cost range ($6,000 – $8,000)

**"Export" button** — downloads as CSV. PM can share with investors.

### 3 — Section 179 eligibility flags (8.18)

On the asset entry form and asset detail view, show an info badge when
`macrs_class = '5_year'` and the asset was placed in service in the current tax year:

`ⓘ Section 179 eligible — full cost may be immediately deductible.
 Confirm with your CPA.`

This is display-only. No calculation change — just a flag for the PM to discuss
with their accountant.

### 4 — Annual depreciation ledger (8.19)

New Inngest function `generate-depreciation-ledger` triggered on demand
(button click from the dashboard, fires event `'asset/depreciation-ledger-requested'`).
Also runs automatically on January 1st each year for the prior tax year.

Add to `events.ts`:
```typescript
'asset/depreciation-ledger-requested': {
  data: {
    org_id:   string
    tax_year: number
  }
}
```

Steps:
1. Load all active assets with `placed_in_service_date` and `purchase_price` set
2. For each asset, calculate depreciation entry using `calculateAnnualDepreciation`
3. UPSERT into `asset_depreciation_entries` (UNIQUE on asset_id + tax_year)
4. Store summary in `org_milestones` with key `depreciation_ledger_{tax_year}`

### 5 — CPA export PDF (8.20)

**Read `/mnt/skills/public/pdf/SKILL.md` before writing this section.**

"Export to CPA" button on the depreciation ledger page.
Triggers a server action that generates a PDF containing:

**Page 1 — Cover**
- Organization name
- Tax year
- "Prepared for use with IRS Publication 946"
- Disclaimer: "This report is for informational purposes only.
  Review all depreciation calculations with your CPA before filing.
  FieldStay does not provide tax advice."

**Page 2+ — Depreciation Schedule by Property**
Group by property, then by asset. For each asset:
- Asset name and type
- Placed in service date
- MACRS class (e.g. "5-Year MACRS")
- Cost basis
- Prior cumulative depreciation
- Current year depreciation
- Ending adjusted basis
- Section 179 note if applicable

**Totals row** per property and grand total at end.

### 6 — Data plate photo scanning (8.1)

On the asset entry form (from Step 10 item 8.2), add a "Scan Data Plate" button
above the manual entry fields. Button only visible on mobile (CSS: `sm:hidden`).

On click: file input with `accept="image/*" capture="environment"`.

On file selection: send image to Claude API for OCR:

```typescript
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 512,
    system:     'You return only valid JSON. No markdown. No explanation.',
    messages: [{
      role:    'user',
      content: [
        {
          type: 'image',
          source: {
            type:       'base64',
            media_type: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
            data:       base64ImageData,
          },
        },
        {
          type: 'text',
          text: `Extract from this appliance/equipment data plate:
- Manufacturer/Brand name
- Model number
- Serial number
- Manufacture year (from nameplate OR decoded from serial number:
  Carrier/Bryant: chars 5–6 of serial = year
  Lennox: first 4 chars YYWW format
  Trane: position 5 = decade, position 6 = year within decade
  York: positions 2–5 encoded date
  If unknown: estimate from visual context)
- Capacity/size (BTU, tons, gallons, etc.)

Return ONLY: {
  "make": string | null,
  "model": string | null,
  "serial_number": string | null,
  "manufacture_year": number | null,
  "capacity": string | null,
  "confidence": "high" | "medium" | "low"
}`,
        },
      ],
    }],
  }),
})
```

On success: pre-populate the form fields. Show confidence badge.
`confidence: 'low'` → show warning: "Low confidence — please verify details."
Fields remain editable — crew always confirms before saving.

### 7 — Bulk CSV asset import (8.3)

CSV format:
`name, asset_type, make, model, serial_number, installation_date, purchase_price,
 estimated_replacement_cost, warranty_expiry_date, warranty_provider, notes`

`asset_type` must match an `AssetType` enum value (case-insensitive, spaces ok:
"HVAC" → "hvac", "Water Heater" → "water_heater").

On upload: parse CSV, validate asset_type values, show a preview table before importing.
Invalid `asset_type` values highlighted in red with a dropdown to correct before submit.
Successful rows INSERT into `property_assets` for the selected property.

---

## New Events to Add to events.ts

```typescript
'asset/capex-projection-generated': {
  data: { org_id: string; tax_year: number }
}

'asset/depreciation-ledger-requested': {
  data: { org_id: string; tax_year: number }
}
```
