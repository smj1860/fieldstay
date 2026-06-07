# Step 10 Pre-Brief: Asset Health — Pillars 1 & 2
# Asset Ledger + Vendor Compliance Vault
# Items: 8.2, 8.4, 8.5, 8.6, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.15

---

## Schema Already Applied — Read Before Writing Anything

All tables exist in the DB. Do NOT run migrations for these.

**`property_assets`** — core asset record. Key columns:
- `id, org_id, property_id, name, asset_type (enum), make, model, serial_number`
- `installation_date DATE` — used to calculate age
- `purchase_price, estimated_replacement_cost NUMERIC`
- `expected_lifespan_years SMALLINT` — overrides the standard if set
- `warranty_expiry_date DATE, warranty_provider TEXT`
- `health_score SMALLINT (0–100)` — cached, recomputed by cron
- `health_score_updated_at TIMESTAMPTZ`
- `macrs_class (enum: 5_year|15_year|27_5_year|39_year|section_179)`
- `placed_in_service_date DATE, depreciation_method TEXT`
- `is_active BOOLEAN (default true)`
- `replaced_by_asset_id UUID (FK self-referential, nullable)`

**`asset_type_standards`** — seed table, 21 rows already seeded. Columns:
- `asset_type (PK enum), display_name, lifespan_min_years, lifespan_max_years`
- `avg_replacement_cost_low, avg_replacement_cost_high`
- `macrs_class_default, vendor_specialty_default`

**`vendor_compliance_documents`** — COI/license tracking. Key columns:
- `id, org_id, vendor_id, document_type (enum: coi|workers_comp|business_license|contractor_license|bonding|other)`
- `document_name, policy_number, issuer_name`
- `effective_date DATE, expiry_date DATE`
- `coverage_amount NUMERIC` (general liability limit for COI)
- `document_url TEXT` (Supabase Storage path)
- `is_verified BOOLEAN, verification_notes TEXT`
- `first_warned_at TIMESTAMPTZ, hard_blocked_at TIMESTAMPTZ`
- `is_active BOOLEAN`

**`vendor_compliance_status`** — VIEW, not a table. Query this for compliance checks.
Returns: `vendor_id, org_id, vendor_name, lat, lng, service_zip, service_radius_miles,
active_doc_count, expired_doc_count, expiring_soon_count, days_past_expiry, compliance_status`

`compliance_status` values:
- `'compliant'` — all docs current
- `'expiring_soon'` — at least one expires within 30 days
- `'grace_period'` — expired 1–30 days ago (soft warn + ack allowed)
- `'hard_blocked'` — expired 31+ days ago (no WO assignment)
- `'no_documents'` — no compliance docs on file

**`work_orders.asset_id UUID`** — nullable FK to property_assets. Already on the table.

---

## types/database.ts — Add These Before Any Other Work

Add the following interfaces. Check if they already exist first — only add if missing:

```typescript
// Asset type enum values (matches DB enum)
export type AssetType =
  | 'hvac' | 'water_heater' | 'roof' | 'refrigerator' | 'washer'
  | 'dryer' | 'dishwasher' | 'microwave' | 'oven_range' | 'pool_pump'
  | 'hot_tub' | 'garage_door' | 'smart_lock' | 'deck_structure'
  | 'electrical_panel' | 'plumbing_system' | 'septic_system' | 'well_pump'
  | 'generator' | 'solar_system' | 'other'

export type MacrsClass = '5_year' | '15_year' | '27_5_year' | '39_year' | 'section_179'

export type ComplianceDocType =
  | 'coi' | 'workers_comp' | 'business_license'
  | 'contractor_license' | 'bonding' | 'other'

export interface PropertyAsset {
  id:                        string
  org_id:                    string
  property_id:               string
  name:                      string
  asset_type:                AssetType
  make:                      string | null
  model:                     string | null
  serial_number:             string | null
  installation_date:         string | null
  manufacture_date:          string | null
  purchase_price:            number | null
  estimated_replacement_cost: number | null
  expected_lifespan_years:   number | null
  warranty_expiry_date:      string | null
  warranty_provider:         string | null
  warranty_notes:            string | null
  placed_in_service_date:    string | null
  macrs_class:               MacrsClass
  depreciation_method:       string
  salvage_value:             number
  health_score:              number | null
  health_score_updated_at:   string | null
  is_active:                 boolean
  replaced_by_asset_id:      string | null
  notes:                     string | null
  created_at:                string
  updated_at:                string
}

export interface AssetTypeStandard {
  asset_type:                  AssetType
  display_name:                string
  lifespan_min_years:          number
  lifespan_max_years:          number
  avg_replacement_cost_low:    number | null
  avg_replacement_cost_high:   number | null
  macrs_class_default:         MacrsClass
  vendor_specialty_default:    string | null
  notes:                       string | null
}

export interface VendorComplianceDocument {
  id:                 string
  org_id:             string
  vendor_id:          string
  document_type:      ComplianceDocType
  document_name:      string
  policy_number:      string | null
  issuer_name:        string | null
  effective_date:     string | null
  expiry_date:        string | null
  coverage_amount:    number | null
  document_url:       string | null
  is_verified:        boolean
  verification_notes: string | null
  first_warned_at:    string | null
  hard_blocked_at:    string | null
  is_active:          boolean
  created_at:         string
  updated_at:         string
}

export interface VendorComplianceStatus {
  vendor_id:           string
  org_id:              string
  vendor_name:         string
  lat:                 number | null
  lng:                 number | null
  service_zip:         string | null
  service_radius_miles: number | null
  active_doc_count:    number
  expired_doc_count:   number
  expiring_soon_count: number
  days_past_expiry:    number | null
  compliance_status:   'compliant' | 'expiring_soon' | 'grace_period' | 'hard_blocked' | 'no_documents'
}
```

Also add `asset_id: string | null` to the `WorkOrder` interface if not already present.

---

## Health Score Formula

Use this exact formula in the daily cron (8.4) and anywhere health score is displayed:

```typescript
interface AssetRepairSummary {
  total_repairs:       number
  total_repair_cost:   number
  last_serviced_at:    string | null  // ISO date of most recent completed WO
}

function calculateHealthScore(
  asset:         PropertyAsset,
  standards:     AssetTypeStandard,
  repairHistory: AssetRepairSummary,
): number {
  if (!asset.installation_date) return 50  // unknown age = neutral

  const installYear  = new Date(asset.installation_date).getFullYear()
  const currentYear  = new Date().getFullYear()
  const ageYears     = currentYear - installYear
  const lifespan     = asset.expected_lifespan_years
    ?? Math.round((standards.lifespan_min_years + standards.lifespan_max_years) / 2)

  // Age component: 0–60 points (full points when new, 0 at end of lifespan)
  const agePct   = Math.min(ageYears / lifespan, 1.0)
  const ageScore = Math.round((1 - agePct) * 60)

  // Repair frequency penalty: 0–20 points deducted
  // > 1 repair/year on average = bad
  const repairsPerYear      = repairHistory.total_repairs / Math.max(ageYears, 1)
  const repairFreqPenalty   = Math.min(20, Math.round(repairsPerYear * 10))

  // Repair cost vs replacement value: 0–15 points deducted
  const replacementCost     = asset.estimated_replacement_cost
    ?? standards.avg_replacement_cost_high
    ?? 5000
  const repairCostPct       = repairHistory.total_repair_cost / replacementCost
  const repairCostPenalty   = Math.min(15, Math.round(repairCostPct * 100))

  // Recency bonus: up to 5 points for recent preventive maintenance
  const monthsSinceService  = repairHistory.last_serviced_at
    ? Math.floor(
        (Date.now() - new Date(repairHistory.last_serviced_at).getTime())
        / (1000 * 60 * 60 * 24 * 30)
      )
    : 999
  const recencyBonus        = monthsSinceService < 6 ? 5
    : monthsSinceService < 12 ? 2
    : 0

  const conditionScore = Math.max(0, 40 - repairFreqPenalty - repairCostPenalty + recencyBonus)
  return Math.max(0, Math.min(100, ageScore + conditionScore))
}

// Score thresholds for color coding
// 80–100 = 🟢 Good
// 60–79  = 🟡 Fair
// 40–59  = 🟠 Aging
// 20–39  = 🔴 Poor
// 0–19   = ⚫ Critical
```

Repair history for a given asset is derived from:
```sql
SELECT
  COUNT(*)                    AS total_repairs,
  COALESCE(SUM(actual_cost), 0) AS total_repair_cost,
  MAX(completed_at)           AS last_serviced_at
FROM work_orders
WHERE asset_id = $1
  AND wo_status = 'completed'
  AND actual_cost IS NOT NULL
```

---

## Build Order for This Step

### 1 — Asset entry form on property detail page (8.2)

Add an "Assets" section to the property detail page. Each property shows its asset list.
"Add Asset" opens a modal/drawer with fields:
- Asset Type (dropdown from `AssetType` enum — use `asset_type_standards.display_name` for labels)
- Name (e.g. "Main HVAC Unit", "Master Bath Water Heater")
- Make, Model, Serial Number (text inputs, all optional)
- Installation Date (date picker)
- Purchase Price, Estimated Replacement Cost (numeric, optional)
- Warranty Expiry Date, Warranty Provider (optional)
- Notes (textarea, optional)

On submit: INSERT into `property_assets`. After saving, auto-populate `expected_lifespan_years`
from `asset_type_standards` if not manually set. Calculate and store initial `health_score`.

### 2 — WO form asset selector (8.8)

On the work order creation form, add an optional "Related Asset" field.
Dropdown of the property's active assets. Sets `work_orders.asset_id`.
Show the asset's current health score next to its name in the dropdown:
`"Main HVAC Unit — Health: 42/100 🟠"`

### 3 — Inngest: daily health score cron (8.4)

Add a step to the existing `dailyMaintenanceCheck` function (check it first —
may already be a good home for this). For each org, for each active `property_asset`:
1. Query repair history from `work_orders` (see SQL above)
2. Calculate health score using the formula above
3. Update `property_assets.health_score` and `health_score_updated_at`
4. If score just crossed a threshold (80→79, 60→59, 40→39, 20→19), fire alert (8.5)

### 4 — Health score threshold alerts (8.5)

When an asset's new score is below a threshold that its previous score was above,
send Resend email to PM:
- Below 60: "⚠️ [Asset] at [Property] has dropped to Fair condition (score: XX)"
- Below 40: "🔴 [Asset] at [Property] is Aging — budget for replacement within 2–3 years (score: XX)"
- Below 20: "🚨 [Asset] at [Property] is Critical — replacement imminent (score: XX)"

To detect threshold crossing: compare new score to `health_score` value BEFORE the update.

### 5 — Asset Health portfolio dashboard (8.6)

New page or tab accessible from the main dashboard. Shows all assets across the portfolio.

Layout: property cards, each with a list of its assets color-coded by health score.
Summary at top: count by status (X Good, X Fair, X Aging, X Poor, X Critical).

A simple table view also works:
`Property | Asset | Type | Age | Health Score | Last Serviced | Action`

The health score renders as a colored pill:
🟢 80+ | 🟡 60–79 | 🟠 40–59 | 🔴 20–39 | ⚫ 0–19

### 6 — Vendor compliance document upload (8.9)

On the vendor detail page, add a "Compliance Documents" section.
List existing documents with: type, expiry date, status badge, verified checkmark.
"Upload Document" button opens a form:
- Document Type (dropdown from `ComplianceDocType` enum)
- Document Name
- Policy/License Number (optional)
- Issuer Name (optional)
- Effective Date, Expiry Date
- Coverage Amount (show only when type = 'coi')
- File upload

File upload: POST to a server action that uploads to Supabase Storage bucket
`compliance-documents` at path `{org_id}/{vendor_id}/{docType}-{timestamp}.{ext}`.
Store the path in `vendor_compliance_documents.document_url`.
Generate a signed URL (1 hour) when displaying/downloading.

### 7 — WO assignment compliance gate (8.10, 8.11, 8.12)

When a vendor is selected on the WO assignment form, query `vendor_compliance_status`
for that vendor. Based on `compliance_status`:

- `'compliant'` — no UI change, proceed normally
- `'expiring_soon'` — show amber warning banner: "⚠️ [Vendor]'s COI expires in X days.
  Consider requesting a renewal before assigning more work."
- `'grace_period'` — show warning modal before allowing assignment:
  Title: "Insurance Expired"
  Body: "[Vendor]'s [document type] expired [N] days ago.
  By proceeding, you acknowledge this assignment despite lapsed insurance coverage."
  Buttons: "Cancel" | "Proceed Anyway"
  On confirm: log `first_warned_at` on the document if not already set.
- `'hard_blocked'` — vendor appears grayed out in the assignment dropdown with badge
  "COI Expired 31+ Days". Cannot be selected. PM must update document first.
  Log `hard_blocked_at` on the document if not already set.
- `'no_documents'` — show amber info banner: "No compliance documents on file for this vendor."

### 8 — COI expiry escalation cron (8.13)

Add to `events.ts`:
```typescript
'vendor-compliance/expiry-warning': {
  data: {
    org_id:      string
    vendor_id:   string
    vendor_name: string
    document_id: string
    document_type: string
    expiry_date: string
    days_until_expiry: number
  }
}
```

In the daily cron, query `vendor_compliance_documents` where `is_active = true`
and `expiry_date` is within the warning windows. Send Resend emails at:
- 30 days before: "Heads up — [Vendor]'s COI expires in 30 days ([date])"
- 14 days before: "Action needed — [Vendor]'s COI expires in 14 days ([date])"
- 7 days before: "Urgent — [Vendor]'s COI expires in 7 days. Update before the grace period ends."
- Day of expiry: "Expired today — [Vendor]'s COI has lapsed. 30-day grace period has started."
- 14 days after: "Grace period — [Vendor]'s COI expired 14 days ago. 16 days remain."
- 30 days after: "Final warning — [Vendor]'s COI expired 30 days ago. Hard block activates tomorrow."

Deduplication: track `last_notified_at` on the document row or use `org_milestones`
with key `compliance_warning:{document_id}:{threshold}` to prevent re-sending.

### 9 — Vendor distance on WO assignment (8.15)

On the WO assignment vendor selector, if the property has `lat`/`lng` and the vendor
has `lat`/`lng`, show distance: "2.4 mi away". Use the haversine function already in
the codebase from Step 7 (`lib/inngest/functions/auto-assign-turnover.ts`).
Extract it to `lib/geocoding.ts` alongside the existing `geocodeZip` function.

---

## Supabase Storage — Create Bucket Before Upload Works

Run this once in the Supabase dashboard SQL editor (not a migration):
```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('compliance-documents', 'compliance-documents', false);
```

The bucket must exist before the first upload attempt.
