# Changelog

All notable changes to FieldStay are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Fixed
- Mobile "More" drawer nav order now matches the desktop sidebar order (Reviews moved directly after Properties)
- Turnover Gantt chart now scales column width, row height, and visible day range for mobile viewports instead of forcing horizontal scroll
- RLS SELECT policy gaps: `org_master_checklist_items`, `org_master_maintenance_schedules`, and `owner_transactions` previously had only an admin/manager `ALL` policy, so crew/viewer roles got zero rows on a plain `SELECT`. Added the standard `_select` policy (any org member) to all three
- Documented `oauth_states`' intentional zero-policy (service-role only) design in a migration comment, matching the precedent for `stripe_processed_events`/`wo_number_counters`

### Verified (no code change needed — already fixed by a prior commit)
- `auto-assign-turnover.ts` autopilot path already checks the `turnover_assignments` insert error and only treats `23505` (duplicate) as a no-op, re-throwing anything else
- `auto-assign-turnover.ts` `record-outcomes` step already upserts on `(turnover_id, crew_member_id)` instead of unconditionally inserting
- `work-order-events.ts` `handleWorkOrderCompleted` already uses `actual_cost` only (no `estimated_cost` fallback) before posting the expense
- `work-order-events.ts` `handleWorkOrderCompletedViaPortal` no longer writes to `owner_transactions` at all (PM notification only), eliminating the dual-handler double-post race with `handleWorkOrderCompleted`

### In Progress
- UI/UX audit implementation: sidebar navigation grouping, dark-mode CSS token fixes, notification bell wiring
- Supabase-generated TypeScript types (replacing hand-maintained `types/database.ts`)

---

## [0.13.0] — 2026-06

### Added
- **Messaging & Follow-ups (Step 13):** Automated guest message scheduler with pre-checkout and booking-confirmation triggers; configurable templates per property; comms log with delivery status tracking

### Changed
- RepuGuard repositioned from separate paid add-on to bundled inclusion for all OwnerRez-connected accounts
- Stripe trial/upsell logic removed from RepuGuard activation route
- RepuGuard upsell UI rewritten to reflect bundled status

### Fixed
- Dark-mode active tab state now uses CSS custom properties instead of hardcoded Tailwind color utilities
- Properties and Owners views: replaced hardcoded light-mode Tailwind classes (`bg-green-50`, `text-amber-600`, etc.) with design tokens

---

## [0.12.0] — 2026-05

### Added
- **Crew Communications & Maintenance Broadcast (Step 12):** In-app crew messaging with push notification support (Web Push / VAPID); maintenance broadcast to all crew members for a property; read receipts

### Changed
- Inngest god function split into four modular cron functions
- `getPmEmail` extracted to shared helper (`lib/helpers/get-pm-email.ts`)
- React Email migration completed for all transactional email templates

### Fixed
- OwnerRez incremental sync: `property_id: null` null overwrite on partial sync payloads
- OwnerRez webhook handler: added payload-ID-based deduplication to handle documented retry behavior
- Inngest: removed illegal nested `step.sleep` call inside `step.run` that caused runtime crashes on 429 responses

---

## [0.11.0] — 2026-04

### Added
- **Asset Health — Photo Documentation (Step 11):** Photo capture workflow for asset condition documentation; photo storage with Supabase Storage; photo viewer in asset detail panel

---

## [0.10.0] — 2026-03

### Added
- **Asset Health — Core + Depreciation (Steps 10 P1/P2):** Property asset registry; AI-powered data plate OCR via Anthropic Claude API (`/api/assets/scan-data-plate`); asset health scoring; depreciation entry tracking; capital planning view

### Changed
- Upstash rate limiting added to data plate scan and RepuGuard generation endpoints

---

## [0.9.0] — 2026-02

### Added
- **Owner Portal:** Tokenized read-only owner access to P&L ledger and property financials; `owner_portal_tokens` table with secure one-time token generation
- **RepuGuard (initial):** AI-generated review response drafts; per-review generation with Anthropic API; response publishing workflow

### Changed
- Owner transactions P&L ledger now auto-posts from: turnover completions (cleaning fee), WO completions (expense), purchase order approvals (inventory expense), OwnerRez booking confirmations (revenue)

---

## [0.8.0] — 2025-12

### Added
- **Work Orders:** Full WO lifecycle (create, assign, in-progress, complete, cancel); vendor assignment with compliance gating; work order line items (labor + materials); photo attachments; status update log; tokenized crew completion flow (`/api/work-orders/[token]/complete`)
- **Vendor Management:** Vendor roster with specialty, geocoordinates, service radius; compliance document vault (COI, licenses, bonding) with expiry tracking; `vendor_compliance_status` view with `compliant | expiring_soon | grace_period | hard_blocked` states
- **Communications:** Guest message templates per property; booking-confirmation and pre-checkout triggers; Resend delivery

### Changed
- OwnerRez integration: OAuth2 connect flow + webhook handler for booking sync

---

## [0.7.0] — 2025-11

### Added
- **Property Setup Wizard:** Multi-step wizard covering property details, checklist templates, inventory templates, crew assignment, iCal sources, maintenance schedules, and guest message templates
- **Checklist Templates:** Org master checklist (73 items, 7 sections); property-level template overrides; checklist instance generation on turnover creation
- **Inventory Templates:** Org-level templates with 115-item seed catalog; property-level overrides with preferred brand; par-level tracking
- **Kroger Integration:** OAuth2 connect flow; cart automation Inngest function triggered when inventory items drop below par; `CartReadyBanner` component

---

## [0.6.0] — 2025-10

### Added
- **Maintenance Schedules:** Recurring maintenance with configurable frequency (weekly → annual); `auto_create_wo` flag; vendor specialty hint for auto-assignment; `next_due_date` tracking; org master maintenance schedules seed (pre-populated)

---

## [0.5.0] — 2025-09

### Added
- **Turnovers:** Auto-generation from booking data; crew suggestion engine (availability + proximity scoring via Mapbox geocoding); `assignment_outcomes` learning loop; same-day turnover premium calculation

---

## [0.4.0] — 2025-08

### Added
- **Bookings:** iCal sync (Airbnb, VRBO, Booking.com, direct); booking status management; Inngest cron for iCal refresh
- **Crew Management:** Crew roster; availability calendar; invite flow with tokenized email link; home location geocoding

---

## [0.3.0] — 2025-07

### Added
- **Properties:** Property CRUD with address geocoding (Mapbox); property type, bedroom count, square footage, financial fields (cleaning cost, same-day premium %, avg nightly rate); property owner contacts

---

## [0.2.0] — 2025-06

### Added
- **Organizations:** Multi-tenant org structure; `organization_members` join table with `admin | manager | crew | viewer | owner` roles; `get_user_org_ids()` and `is_org_member()` RLS helper functions; org invite flow
- **Stripe Billing:** Subscription tiers (Starter, Growth, Pro, Enterprise); webhook handler with signature verification; Stripe Customer Portal integration

---

## [0.1.0] — 2025-05

### Added
- Next.js 15 App Router scaffold on Vercel
- Supabase Auth (email + password) with `@supabase/ssr`
- PowerSync local-first sync layer; sync rules scaffolded
- Inngest client + event type registry (`lib/inngest/events.ts`)
- CSS custom property design system (navy/yellow brand palette, dark mode)
- `.env.example` with full variable documentation
- `vercel.json` with security headers and function timeout overrides
- GitHub Dependabot weekly npm updates
