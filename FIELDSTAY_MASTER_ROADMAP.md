# FieldStay — Master Build Roadmap
*Updated June 29, 2026 — Single source of truth for all planned work*

> **Note:** Significant features were built between June 6 and June 29 that are
> not reflected in the original track structure. See **TRACK 0 — BUILT SINCE
> CUTOFF** below for the complete list of features now live in production.

---

## Legend
- ✅ Done — Migration applied or decision locked
- 🔧 Code Needed — DB ready, implementation not yet written
- 📋 Not Started — Planned, no work done yet
- 💬 Pending Decision — Needs a call before building
- ⚠️  Blocking — Other work depends on this

---

## TRACK 0 — BUILT SINCE JUNE 6 CUTOFF (All Live in Production)

These features were designed and built after the June 6 roadmap cutoff.
They are not represented in Tracks 1–9 below.

### Self-Funding Guidebook ✅
- Guest-facing portal: tokenized URL `/g/b/[token]` with WiFi, check-in
  instructions, door code, and local sponsor recommendations
- Property QR codes at `/g/[slug]` with auto-generated slugs from OwnerRez sync
- Sponsor model: $15/month per slot, plan credits at 5 and 6 active sponsors,
  free tier unlocks at 4+ sponsors, grace period on cancellation
- Pre-arrival email with door code CTA (de-duped, sent once per booking)
- Guest SMS opt-in hook ("Want your door code texted?") — near-100% conversion
- Check-in SMS: door code + WiFi + portal link (atomic claim, race-condition safe)
- Morning and evening contextual nudges driven by OwnerRez amenity flags and
  Tomorrow.io live weather (hot tub timing, fire pit weather, dinner recommendations)
- Stay extension / gap night messaging: PM-configurable discount and contact method,
  SMS offer to opted-in guests, card in guest portal near checkout
- Media kit page with PM-shareable sponsor pitch
- Sponsor checkout via Stripe, lifecycle managed by Inngest
- TCPA compliance: NANP phone validation, booking window checks, STOP/START/HELP
  handling, consent audit log
- `SMS_ENABLED=false` env var gates all sends — flip after 10DLC verification

### RepuGuard ✅ (was deferred in Track 6 — now live)
- AI-generated review response drafts using Claude Sonnet
- Bundled into all FieldStay tiers — not a paid add-on
- Automatic batch generation for new reviews synced from OwnerRez
- 2 regenerations per synced review, 0 for manual pastes
- Manual review paste: 2 per org per week, covers Airbnb / Vrbo / Google / Booking
- Flag detection: legal, safety, billing issues surface before PM edits
- Deadline tracking with urgency sort (PM has 14 days from review date)
- "Post to OwnerRez" confirmation flow

### OwnerRez Integration ✅ (full production)
- OAuth 2.0 connection with token refresh and revocation
- Property sync: name, address, bedrooms, bathrooms, lat/lng, max_guests,
  amenity flags (from listings endpoint), WiFi credentials, check-in instructions,
  house manual, checkout instructions, occupancy rules
- Booking sync: all fields including guest name/email, status, channel, is_block
- Review sync: cursor-based, only pulls reviews after connection date
- Webhook registration: booking.created / modified / cancelled, guest events,
  entity_update, authorization_revoked
- Per-property fan-out for detail API calls (memoized Inngest steps)
- Guidebook property configs auto-created from sync with slug generation

### Hostaway Integration ✅ (adapter built, marketplace listing pending)
- Property and booking sync adapter at `lib/inngest/functions/hostaway/`
- O(n²) array scan replaced with Map-based O(1) lookup

### Crew PWA — Dexie.js ✅ (PowerSync replaced)
- Full offline-first capability via Dexie.js IndexedDB + custom mutation outbox
- Crew work orders: assigned WOs appear in Today/Upcoming columns
- Work order detail page with Mark Complete → PM notification email
- Per-item notes on inventory count (mirrors checklist notes)
- Info/FAQ panel covering app features, par levels, photo rationale
- Feedback form → `crew_feedback` table
- Branded header with FieldStay/gold wordmark and gold welcome bar
- Support link surfaces `help@fieldstay.app`

### Turnovers Board ✅
- Archive completed turnovers (manual, `is_archived` column)
- Default view: upcoming 14 days (no blank page on first load)
- Crew name pills use lighter blue-100/blue-700 styling

### Work Orders ✅
- Assign Crew mode on WO form (suppresses vendor/invoice path)
- Crew WOs sync to crew app via Dexie
- Vendor assignment email fires on ALL assignment paths including post-creation
  assignment and bulk assign (previously only fired at creation time)

### 10DLC / SMS ✅ (campaign submitted, pending carrier verification)
- Telnyx A2P registration submitted: Low Volume Mixed, Account Notification +
  Marketing use cases
- Ed25519 webhook signature verification live
- STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/HELP/INFO/SUPPORT all handled
- Campaign description, opt-in workflow, sample messages submitted
- Flip `SMS_ENABLED=true` after campaign verification clears

---

## TRACK 1 — BUG FIXES & STABILITY

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | RLS: `owner` role excluded from all write policies | ✅ | Fixed via `is_org_member()` function |
| 1.2 | `owner_transactions` INSERT blocked | ✅ | Covered by 1.1 + policy rewrite |
| 1.3 | `communication_logs` duplicate/conflicting policies | ✅ | Consolidated to 2 clean policies |
| 1.4 | `properties` missing WITH CHECK on manage policy | ✅ | Rewritten |
| 1.5 | `assigned_crew_id` vs `assigned_crew_member_id` dual columns | ✅ | Old column deprecated |
| 1.6 | Property setup wizard — mobile layout breaks at narrow width | ✅ | Step nav + content panel must stack vertically |
| 1.7 | `memberships` table reference in server actions | ✅ | Table is `organization_members` — zero `.from('memberships')` occurrences confirmed app-wide |
| 1.8 | Onboarding wizard step 3 inventory panel off-screen on mobile | ✅ | Two-column layout clips off right edge |

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
| 2.1 | Turnover marked complete | Auto-create cleaning fee expense (`source = 'cleaning_fee'`). Applies `same_day_premium_pct` if `is_same_day_turnover = true`. Reads `property.cleaning_cost`. | ✅ |
| 2.2 | Work order marked complete with `actual_cost` set | Auto-create expense (`source = 'wo_completion'`). Idempotent via `source_reference_id`. | ✅ |
| 2.3 | Purchase order approved | Auto-create expense per property (`source = 'inventory_purchase'`) | ✅ |
| 2.4 | OwnerRez booking confirmed | Auto-create revenue (`source = 'booking_revenue'`) | ✅ |
| 2.5 | Uplisting booking confirmed | Auto-create revenue (`source = 'uplisting_booking'`) | 🔧 |
| 2.6 | All functions | Idempotency via `source_reference_id` — never duplicate for same source record | ✅ |

### 2C — UI

| # | Item | Status |
|---|---|---|
| 2.7 | Property card: `cleaning_cost` + `same_day_premium_pct` fields | ✅ |
| 2.8 | Property setup wizard step 1: financial fields | ✅ |
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
| 3.1 | Property geocoding — zip → lat/lng on property save (Mapbox) | ✅ |
| 3.2 | Vendor geocoding — zip → lat/lng on vendor save (same Mapbox pattern) | ✅ |
| 3.3 | Inngest: auto-assignment scoring engine | 🔧 |
| 3.4 | Suggest mode: populate `turnovers.suggested_crew_ids` + `suggestion_reasoning` | 🔧 |
| 3.5 | Autopilot mode: assign directly + Resend notification to PM | 🔧 |
| 3.6 | Gap detection: no crew available → flag + email PM | 🔧 |
| 3.7 | Turnover Board: "⚡ Suggested: [Name] — [reason]" one-tap confirm UI | 🔧 |
| 3.8 | PM override → record to `assignment_outcomes.was_accepted = false` | 🔧 |
| 3.9 | Checklist completion timestamps → populate `assignment_outcomes` duration | 🔧 |
| 3.10 | Org settings: auto-assign mode toggle (Suggest / Autopilot / Off) | 🔧 |
| 3.11 | Crew app: monthly availability calendar (tap to toggle) | 📋 Phase 9 |
| 3.12 | Add `crew_availability` to Dexie sync pull in DexieProvider | 📋 Phase 9 |

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
| 6.2 | Dexie: add `messages` table to DexieProvider pull sync + Dexie schema | 📋 | Match existing Dexie table pattern in `lib/dexie/schema.ts` |
| 6.3 | `lib/dexie/schema.ts` — add messages table interface + version bump | 📋 | |
| 6.4 | Inngest: `message/sent` → push notify + Comms Log entry | 📋 | |
| 6.5 | PM dashboard: Messages page (split-pane) | 📋 | |
| 6.6 | Crew app: Messages page (Dexie `useLiveQuery` reads) | 📋 | |
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
**⏸️ Deferred to end of year.** RepuGuard is live and covers OwnerRez-synced reviews
plus manual review paste (2/week per org) for Airbnb, Vrbo, Google, and Booking reviews.
No Google API integration needed until 2027.

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
| 6.23 | `crew_availability` to Dexie DexieProvider pull sync | 📋 |
| 6.24 | `lib/dexie/schema.ts` — add crew_availability table + version bump | 📋 |
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
| P3 | Smart lock integration | Seam deferred entirely. Google Nest (credentials in hand: Cloud project, Device Access Console, OAuth Client ID) and Ecobee planned via shared ThermostatProvider abstraction. Build after go-live. |
| P4 | Google Reviews | Deferred to end of year. OwnerRez API covers review access through 12/31 |
| P5 | PWA icons | Need FieldStay-branded `icon-192.png` and `icon-512.png` for manifest. PWA install prompt and notification permission flow documented in crew app FAQ. |
| P6 | Minut noise monitoring | API is public. High relevance for STR guest management. Evaluate after smart lock decision |
| P7 | Phyn/Moen water sensor integration | API available. Premium property add-on. Future partnership territory |
| P8 | Pricing review | No feature gating confirmed. May warrant slight price increase to reflect full platform value |
| P9 | Hospitable integration | OAuth 2.0 architecture designed, application submitted, awaiting approval. Build after OwnerRez marketplace launch. |
| P10 | MealMe integration | Potential replacement/supplement to Kroger for multi-retailer inventory ordering. Instrument PO volume/GMV data first before evaluating pricing. |
| P11 | TradeSuite build phase | July 28, 2026 calendar reminder set. Standalone Next.js deployment, shared Supabase infra TBD. |
| P12 | Minut / NoiseAware | Noise monitoring evaluation. Minut via direct enterprise conversation preferred. |
| P13 | Smart thermostat | Google Nest credentials in hand. Ecobee also planned. Build simultaneously behind shared ThermostatProvider abstraction. |

---

## RECOMMENDED BUILD ORDER

### Live in Production (Track 0)
- Self-Funding Guidebook ✅
- RepuGuard ✅
- OwnerRez Integration (full) ✅
- Hostaway adapter ✅
- Crew PWA (Dexie) ✅
- 10DLC submitted, pending carrier verification ✅

### Active — Paul Testing
- OwnerRez marketplace listing review
- SMS: flip `SMS_ENABLED=true` after 10DLC campaign clears

### Next — Unblocked
1. **Track 2 remaining** — Owner portal `visible_to_owner` toggle (2.9), non-integration revenue input (2.10)
2. **Track 3.3–3.10** — Auto-assignment scoring engine + Turnover Board suggest UI
3. **Track 4.8–4.17** — Kroger brand fields UI, store selector, build cart button
4. **Track 5** — Full owner portal P&L view

### After Marketplace Launch
5. **Hospitable integration** — OAuth 2.0, per-user webhook registration, HMAC middleware
6. **Smart thermostat** — Nest + Ecobee via ThermostatProvider abstraction
7. **Track 7** — Reactive maintenance automation (WO aging, repeat issue detection)
8. **Track 8** — Asset Health module (Pillars 1–3)

### July 28, 2026
9. **TradeSuite build phase** — standalone deployment, Vite → Next.js migration,
   work order → invoice flow

### Phase 9 (Later)
10. **Track 6** — In-app messaging, comms log retention, maintenance template broadcasting,
    crew availability calendar (all PowerSync references updated to Dexie)

---

*Roadmap last updated: June 29, 2026. Track 0 documents all features built since
the June 6 cutoff. Status counts below reflect Tracks 1–9 only and are
approximate — refer to Track 0 for current production feature state.*
*Sessions: This conversation. Hand off implementation sprints to Claude Code.*
