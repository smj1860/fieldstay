# FieldStay — Master Build Roadmap
*Updated June 6, 2026 — Single source of truth for all planned work*

---

## Legend
- ✅ Done — Migration applied or decision locked
- 🔧 Code Needed — DB ready, implementation not yet written
- 📋 Not Started — Planned, no work done yet
- 💬 Pending Decision — Needs a call before building
- ⚠️  Blocking — Other work depends on this

---

## TRACK 1 — BUG FIXES & STABILITY

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | RLS: `owner` role excluded from all write policies | ✅ | Fixed via `is_org_member()` function |
| 1.2 | `owner_transactions` INSERT blocked | ✅ | Covered by 1.1 + policy rewrite |
| 1.3 | `communication_logs` duplicate/conflicting policies | ✅ | Consolidated to 2 clean policies |
| 1.4 | `properties` missing WITH CHECK on manage policy | ✅ | Rewritten |
| 1.5 | `assigned_crew_id` vs `assigned_crew_member_id` dual columns | ✅ | Old column deprecated |
| 1.6 | Property setup wizard — mobile layout breaks at narrow width | 🔧 | Step nav + content panel must stack vertically |
| 1.7 | `memberships` table reference in server actions | ⚠️ 🔧 | Table is `organization_members` — audit all `.from('memberships')` calls before testing |
| 1.8 | Onboarding wizard step 3 inventory panel off-screen on mobile | 🔧 | Two-column layout clips off right edge |

---

## TRACK 2 — FINANCIAL AUTOMATION ENGINE

### 2A — Schema ✅ All Applied
- `properties.cleaning_cost` + `same_day_premium_pct` + `cleaning_cost_visible_to_owner`
- `properties.square_footage` + `lat` + `lng`
- `organizations.auto_assign_mode` (suggest / autopilot / disabled)
- `organizations.preferred_retailer` + Kroger connection fields
- `organizations.uplisting_api_key` (pending — add when Uplisting wired)
- `owner_transactions.source` + `source_reference_id` + `visible_to_owner`
- `turnovers.is_same_day_turnover` + suggestion state columns

### 2B — Automation Inngest Functions

| # | Trigger | Action | Status |
|---|---|---|---|
| 2.1 | Turnover marked complete | Auto-create cleaning fee expense (`source = 'cleaning_fee'`). Applies `same_day_premium_pct` if `is_same_day_turnover = true`. Reads `property.cleaning_cost`. | 🔧 |
| 2.2 | Work order marked complete with `actual_cost` set | Auto-create expense (`source = 'wo_completion'`). Idempotent via `source_reference_id`. | 🔧 |
| 2.3 | Purchase order approved | Auto-create expense per property (`source = 'inventory_purchase'`) | 🔧 |
| 2.4 | OwnerRez booking confirmed | Auto-create revenue (`source = 'booking_revenue'`) | 🔧 |
| 2.5 | Uplisting booking confirmed | Auto-create revenue (`source = 'uplisting_booking'`) | 🔧 |
| 2.6 | All functions | Idempotency via `source_reference_id` — never duplicate for same source record | 🔧 |

### 2C — UI

| # | Item | Status |
|---|---|---|
| 2.7 | Property card: `cleaning_cost` + `same_day_premium_pct` fields | 🔧 |
| 2.8 | Property setup wizard step 1: financial fields | 🔧 |
| 2.9 | Owner portal: `visible_to_owner` toggle on expense entries | 🔧 |
| 2.10 | Non-OwnerRez/Uplisting path: monthly revenue input field per property | 🔧 |

---

## TRACK 3 — SMART CREW AUTO-ASSIGNMENT

### 3A — Schema ✅ All Applied
- `crew_availability` table
- `assignment_outcomes` table (learning loop — uses checklist timestamps for duration)
- `crew_members.reliability_score` + `capacity_score` + `home_lat/lng`
- `properties.lat` + `lng`
- `turnovers.suggested_crew_ids` + `suggestion_reasoning` + `suggestion_status`
- `organizations.auto_assign_mode`

### 3B — Scoring Formula (5 Weighted Factors)
1. **Familiarity (0.35)** — has crew cleaned this property before? Derived from `assignment_outcomes`
2. **Workload Balance (0.25)** — inverse of same-day assignment count
3. **Geographic Proximity (0.25)** — distance from other same-day assignments (increases to 0.40 on same-day turnovers)
4. **Capacity (0.10)** — affinity for property size, derived from history
5. **Reliability (0.05)** — on-time rate + PM ratings from `assignment_outcomes`

**Duration tracking:** `started_at` = first checklist item timestamp. `completed_at` = last checklist item timestamp. Cap at 480 min to exclude anomalous gaps (computed column in DB).

### 3C — Build Items

| # | Item | Status |
|---|---|---|
| 3.1 | Property geocoding — zip → lat/lng on property save (Mapbox) | 🔧 |
| 3.2 | Vendor geocoding — zip → lat/lng on vendor save (same Mapbox pattern) | 🔧 |
| 3.3 | Inngest: auto-assignment scoring engine | 🔧 |
| 3.4 | Suggest mode: populate `turnovers.suggested_crew_ids` + `suggestion_reasoning` | 🔧 |
| 3.5 | Autopilot mode: assign directly + Resend notification to PM | 🔧 |
| 3.6 | Gap detection: no crew available → flag + email PM | 🔧 |
| 3.7 | Turnover Board: "⚡ Suggested: [Name] — [reason]" one-tap confirm UI | 🔧 |
| 3.8 | PM override → record to `assignment_outcomes.was_accepted = false` | 🔧 |
| 3.9 | Checklist completion timestamps → populate `assignment_outcomes` duration | 🔧 |
| 3.10 | Org settings: auto-assign mode toggle (Suggest / Autopilot / Off) | 🔧 |
| 3.11 | Crew app: monthly availability calendar (tap to toggle) | 📋 Phase 9 |
| 3.12 | Add `crew_availability` to PowerSync publication | 📋 Phase 9 |

---

## TRACK 4 — KROGER SHOPPING CART

### 4A — Schema ✅ All Applied
- `inventory_template_items.preferred_brand` + `inventory_items.preferred_brand`
- `organizations.preferred_retailer` + Kroger OAuth token fields
- `organizations.kroger_location_id` + `kroger_location_name`

### 4B — Code Written This Session (needs commit + verified imports)

| # | File | Status |
|---|---|---|
| 4.1 | `lib/kroger/types.ts` | ✅ Written |
| 4.2 | `lib/kroger/client.ts` | ✅ Written |
| 4.3 | `inngest/functions/build-shopping-cart.ts` | ✅ Written |
| 4.4 | `app/api/kroger/connect/route.ts` | ✅ Written |
| 4.5 | `app/api/kroger/callback/route.ts` | ✅ Written |
| 4.6 | `app/(dashboard)/inventory/actions.ts` — `triggerShoppingCart()` | ✅ Written |
| 4.7 | `CartReadyBanner` component | ✅ Written |

### 4C — Still Needed

| # | Item | Status | Notes |
|---|---|---|---|
| 4.8 | Inventory template builder: brand field + education copy block | 🔧 | |
| 4.9 | Property setup wizard step 3: property-level brand override | 🔧 | |
| 4.10 | Portfolio inventory table: Brand column | 🔧 | |
| 4.11 | Settings: "Connect Kroger Account" button | 🔧 | |
| 4.12 | Settings: nearest store selector | 🔧 | |
| 4.13 | Portfolio inventory: "Build Cart" button with portfolio/property filter | 🔧 | Supports both all-properties and filtered modes |
| 4.14 | `lib/resend/emails/shopping-cart-ready.tsx` | 🔧 | |
| 4.15 | Register `buildShoppingCart` in `app/api/inngest/route.ts` | 🔧 | |
| 4.16 | CSV upload: add `brand` column + hint text | 🔧 | |
| 4.17 | `applyTemplateToProperties`: copy `preferred_brand` to `inventory_items` | 🔧 | |

---

## TRACK 5 — OWNER PORTAL

| # | Item | Status | Notes |
|---|---|---|---|
| 5.1 | WO complete → auto-expense (Inngest) | 🔧 | Same as 2.2 |
| 5.2 | OwnerRez booking → auto-revenue (Inngest) | 🔧 | |
| 5.3 | Uplisting booking → auto-revenue (Inngest) | 🔧 | Add `uplisting_api_key` to organizations |
| 5.4 | Inventory purchase → auto-expense (Inngest) | 🔧 | Same as 2.3 |
| 5.5 | Cleaning fee → auto-expense on turnover complete | 🔧 | Same as 2.1 |
| 5.6 | `visible_to_owner` toggle on expense entries | 🔧 | |
| 5.7 | Owner portal: P&L view (revenue - expenses = net per property) | 🔧 | |
| 5.8 | Non-integration path: monthly revenue input field | 🔧 | |
| 5.9 | Multi-property owner portal (single link, multiple properties) | 📋 | Schema: `owner_portal_tokens` becomes org-scoped |

---

## TRACK 6 — PHASE 9 FEATURES (Not Started)

### Task 1 — In-App Messaging: PM ↔ Crew

| # | Item | Status | Notes |
|---|---|---|---|
| 6.1 | `messages` table + RLS | 📋 | Fix `memberships` → `organization_members` in policy before applying |
| 6.2 | PowerSync: add `messages` table to publication | 📋 | Verify not `puballtables` first |
| 6.3 | `lib/powersync/schema.ts` — messages table | 📋 | |
| 6.4 | Inngest: `message/sent` → push notify + Comms Log entry | 📋 | |
| 6.5 | PM dashboard: Messages page (split-pane) | 📋 | |
| 6.6 | Crew app: Messages page (PowerSync reads) | 📋 | |
| 6.7 | Nav: Messages in PM dashboard + crew app | 📋 | |
| 6.8 | PWA: `app/manifest.ts`, service worker, icons | 📋 | Icons: `app/icon.png`, `app/apple-icon.png`, `public/icon-192.png`, `public/icon-512.png` |
| 6.9 | `push_subscriptions` table | 📋 | |
| 6.10 | Optional: PM Slack incoming webhook for event notifications | 📋 | Crew → PWA messaging. PM → optional Slack ping for key events |

### Task 2 — Comms Log Retention

| # | Item | Status |
|---|---|---|
| 6.11 | `communication_logs.deleted_at` + retention index | 📋 |
| 6.12 | `organizations.comms_log_retention_days` (default 365) | 📋 |
| 6.13 | All Comms Log queries: add `.is('deleted_at', null)` filter | 📋 |
| 6.14 | Inngest cron: soft-delete → 30-day grace → hard purge | 📋 |
| 6.15 | Auto-log emailed work orders to Comms Log | 📋 |
| 6.16 | Org settings: retention period selector | 📋 |

### Task 3 — Google Reviews
**⏸️ Deferred to end of year.** RepuGuard is OwnerRez-only through 12/31 and OwnerRez API provides review access. No Google API integration needed until 2027.

### Task 4 — Maintenance Schedule Template Broadcasting

| # | Item | Status | Notes |
|---|---|---|---|
| 6.17 | `maintenance_schedule_templates` + `_items` tables + RLS | 📋 | |
| 6.18 | Seed data: **36 items across 8 categories** (expanded from original 10) | 📋 | See categories: HVAC/Air, Safety/Code, Plumbing/Water, Exterior/Structure, Pest/Landscape, Interior Appliances, Seasonal |
| 6.19 | `vendor_specialty_hint` added to template items on seed | 📋 | Enables auto-vendor matching on broadcast |
| 6.20 | PM UI: template browser + customize + broadcast to selected properties | 📋 | |
| 6.21 | Broadcast action: skip existing by name (idempotent) | 📋 | |

### Task 5 — Crew Availability Calendar
*Schema applied. UI remains.*

| # | Item | Status |
|---|---|---|
| 6.22 | Crew app: monthly availability calendar | 📋 |
| 6.23 | `crew_availability` to PowerSync publication | 📋 |
| 6.24 | `lib/powersync/schema.ts` updated | 📋 |
| 6.25 | Turnover Board: availability indicator on assignment | 📋 |

---

## TRACK 7 — REACTIVE MAINTENANCE AUTOMATION

| # | Item | Status | Notes |
|---|---|---|---|
| 7.1 | WO aging/escalation: Inngest `step.sleep` — if WO open > X days → change priority to urgent + notify PM | 🔧 | Configurable threshold per org |
| 7.2 | Repeat issue detection: 3+ WOs same category at same property in 90 days → flag PM | 🔧 | Daily Inngest cron |
| 7.3 | Crew "Flag for WO" during turnover | ✅ | Already in codebase — validate only |
| 7.4 | Seasonal maintenance → auto-create WO draft when `next_due_date` reached | 🔧 | `auto_create_wo` now defaults to `true`. Vendor matching via `vendor_specialty_hint` |

---

## TRACK 8 — ASSET HEALTH MODULE

### 8A — Schema ✅ All Applied
- `asset_type_standards` — 21 asset types with lifespan + replacement cost ranges
- `property_assets` — asset ledger with health score cache, CapEx fields, warranty tracking
- `vendor_compliance_documents` — COI, licenses, bonding with expiry tracking
- `vendor_compliance_status` view — 4-state compliance gate: `compliant`, `expiring_soon`, `grace_period` (days 1–30), `hard_blocked` (day 31+)
- `asset_depreciation_entries` — annual MACRS depreciation records
- `work_orders.asset_id` — links WOs to tracked assets (repair history for health score)
- `vendors.lat` + `lng` + `service_zip` + `service_radius_miles`
- `vendor_compliance_documents.first_warned_at` + `hard_blocked_at` (audit trail)

### 8B — Locked Decisions
- **Compliance gate:** Soft warn + PM acknowledgment (days 1–30). Hard block day 31+. Acknowledgment is timestamped and logged.
- **Feature access:** No gating. All plans. Full platform on day one.
- **Depreciation scope:** Capital assets only (5-year and 15-year MACRS). IRS Publication 946 + Section 179.
- **Reports:** Carry disclaimer "For use with IRS Pub 946. Review with your CPA before filing."
- **Standalone vs integrated:** Integrated into FieldStay with clean module boundary for future API extraction.

### 8C — Build Items

**Pillar 1: Asset Ledger (Physical Health)**

| # | Item | Status |
|---|---|---|
| 8.1 | Crew app: "Scan Data Plate" → Claude Vision → auto-populate asset form | 🔧 |
| 8.2 | PM property detail: manual asset entry form | 🔧 |
| 8.3 | PM property detail: bulk asset CSV import | 🔧 |
| 8.4 | Inngest daily cron: health score recalculation for all active assets | 🔧 |
| 8.5 | Health score threshold alert: when score crosses 60, 40, or 20 → notify PM | 🔧 |
| 8.6 | Asset Health dashboard: portfolio heatmap, color-coded by score | 🔧 |
| 8.7 | Repair vs. Replace Calculator: shown on WO creation when asset is linked | 🔧 |
| 8.8 | WO form: asset selector (links work order to tracked asset) | 🔧 |

**Pillar 2: Vendor Compliance Vault (Risk Management)**

| # | Item | Status |
|---|---|---|
| 8.9 | Vendor detail page: compliance document upload (Supabase Storage) | 🔧 |
| 8.10 | WO assignment form: compliance gate check via `vendor_compliance_status` view | 🔧 |
| 8.11 | Grace period warning modal with PM acknowledgment (logs timestamp) | 🔧 |
| 8.12 | Hard block UI: vendor grayed out with "COI expired 31+ days" badge | 🔧 |
| 8.13 | Inngest: COI expiry escalation ladder — 30d / 14d / 7d / expiry day / +14d / +30d | 🔧 |
| 8.14 | Vendor geocoding on create/update (Mapbox, same pattern as properties) | 🔧 |
| 8.15 | Vendor list: distance-from-property shown on WO assignment | 🔧 |

**Pillar 3: CapEx & Depreciation Hub (Financial Reporting)**

| # | Item | Status |
|---|---|---|
| 8.16 | Inngest monthly cron: generate CapEx projections (3/5/10-year) | 🔧 |
| 8.17 | CapEx forecast UI: bar chart by year + itemized list per property | 🔧 |
| 8.18 | Section 179 eligibility flag on applicable assets | 🔧 |
| 8.19 | Annual depreciation ledger: compute MACRS rates, store in `asset_depreciation_entries` | 🔧 |
| 8.20 | One-click CPA export: PDF depreciation report (IRS Pub 946 formatted) | 🔧 |

---

## TRACK 9 — SEED DATA (✅ Complete)

| Item | Before | After |
|---|---|---|
| Inventory catalog | 39 items / 6 categories | 115 items / 10 categories |
| Turnover checklist | 53 items / 7 sections | 73 items / 7 sections |
| Maintenance seed template | Not built yet | 36 items / 8 categories (Phase 9 Task 4) |
| Asset type standards | Not built yet | 21 asset types with lifespan + cost ranges (✅) |

---

## PENDING DECISIONS

| # | Item | What's Needed |
|---|---|---|
| P1 | Bookings module | Direct/social/phone bookings only (not iCal). Architecture clear — build when ready |
| P2 | Uplisting API — booking confirmed event vs rate-only? | Affects whether revenue auto-population works or needs nightly-rate × nights calculation |
| P3 | Smart lock integration | Seam confirmed as provider if built. $10+/property/month add-on. Build only on PM demand |
| P4 | Google Reviews | Deferred to end of year. OwnerRez API covers review access through 12/31 |
| P5 | PWA icons | Need FieldStay-branded `icon-192.png` and `icon-512.png` for manifest |
| P6 | Minut noise monitoring | API is public. High relevance for STR guest management. Evaluate after smart lock decision |
| P7 | Phyn/Moen water sensor integration | API available. Premium property add-on. Future partnership territory |
| P8 | Pricing review | No feature gating confirmed. May warrant slight price increase to reflect full platform value |

---

## RECOMMENDED BUILD ORDER

### Immediate — Unblocks Testing
1. **1.7** — `memberships` → `organization_members` audit (do before any testing)
2. **1.6, 1.8** — Mobile layout fixes (property wizard)

### Sprint 1 — Core Automation (Highest PM Value)
3. **2.7, 2.8** — Property card financial fields UI
4. **2.1–2.6** — All four financial automation Inngest functions
5. **3.1, 3.2** — Property and vendor geocoding

### Sprint 2 — Kroger + Auto-Assignment
6. **4.8–4.17** — Kroger brand fields UI, register Inngest function
7. **3.3–3.10** — Auto-assignment scoring engine + Turnover Board suggest UI

### Sprint 3 — Owner Portal Complete
8. **5.1–5.9** — Full owner portal automation + P&L view

### Sprint 4 — Reactive Maintenance
9. **7.1–7.4** — WO aging escalation, repeat issue detection, auto-WO from schedule

### Sprint 5 — Asset Health (MVP)
10. **8.1–8.15** — Pillars 1 and 2 (Asset Ledger + Compliance Vault)
11. **8.16–8.20** — Pillar 3 (CapEx + Depreciation)

### Sprint 6 — Phase 9
12. Tasks 1, 2, 4, 5 from CLAUDE_9_0.md in priority order

---

*Total tracked items: 98 | ✅ Done: 28 | 🔧 Code needed: 55 | 📋 Not started: 15*
*Sessions: This conversation. Hand off implementation sprints to Claude Code.*
