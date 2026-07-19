# Future Additions

Proposed features that have been scoped in real detail — against the actual
codebase, with file/line citations — but not yet built. Unlike
`FUTURE_REMEDIATION.md` (known gaps in existing code), these are net-new
capabilities. Each entry has enough grounding to start implementation
without re-deriving the architecture from scratch.

---

## 1. Offline-capable PM PWA, scoped to PM-selected properties

**Concept:** a second, separately-installable PWA (mirroring the existing
crew app's architecture) that gives a property manager offline access to
**maintenance, inventory, and checklist** data — but only for properties
the PM has explicitly opted into via a Settings page, not the whole org.
A PM working a portfolio with poor-signal properties loads just those onto
the device; the selection is fully editable any time they're online.

### Why this shape, not the alternatives considered

Two broader versions were considered and rejected during scoping
conversation:

- **Whole dashboard offline** — rejected. Large parts of the dashboard
  (Stripe billing, OAuth integration connects, owner portal token
  generation, team invites) require live connectivity and immediate
  server confirmation; queuing those in an offline outbox to replay
  silently later is dangerous, not just complex. It would also mean
  permanently caching financial/compliance data (owner ledgers, vendor
  compliance docs) on local device storage — a materially bigger
  exposure than operational status data.
- **Org-wide (all properties) offline, still just 3 feature areas** —
  rejected in favor of PM-selectable properties. Org-wide sync payloads
  scale with total portfolio size regardless of what a PM actually
  needs offline; property-selection bounds the sync payload, initial
  hydration time, device storage footprint, and multi-user
  write-conflict blast radius to whatever the PM actually chose.

### What already exists and is directly reusable

The crew PWA (`app/crew/*`) already proves out almost the entire
architecture this needs. Nothing below needs to be invented from
scratch — it needs to be **extended with a property-scoped filter**
instead of the crew's `crew_member_id`/assignment-scoped filter.

- **The local-first engine** — `lib/dexie/schema.ts` (per-user IndexedDB
  database, `FieldStayDexie` class, mutation outbox table), plus
  `lib/dexie/syncService.ts` (`enqueueMutation()`, `SyncEngine.processOutbox()`
  with a proven graduated retry policy: stop-the-queue on attempts 1–2 so
  later mutations against the same record aren't applied out of order,
  skip-and-continue on attempts 3–4, dead-letter at attempt 5 — never
  silently drops a mutation).
- **The route-handler-for-side-effects pattern** — already solves the
  "what happens to automations if the offline write only lands hours
  later" problem, because it already *is* how the crew app handles
  status transitions with cascading effects. `uploadTurnoverChange()`
  in `syncService.ts` routes `status: 'completed'` through
  `POST /api/crew/turnovers/:id/complete` (not a direct table write) so
  the completion pipeline — cleaning-fee posting, PM notification,
  duration tracking — fires when the write actually reaches the server,
  whenever that is. The same shape applies directly here: an offline
  edit to a maintenance schedule that should trigger vendor auto-assign,
  or an offline-created work order, routes through a Route Handler on
  sync, and the existing Inngest-driven automation fires exactly when
  that handler runs — no new design needed for this, just new handlers
  following the existing shape.
- **A property-scoped sync filter already exists as a precedent** — not
  for maintenance/inventory, but for asset discovery:
  `computeAssignedPropertyIds()` + `syncPropertyAssets()` in
  `lib/dexie/sync/assets.ts` already do `.in('property_id', propertyIds)`
  and build Realtime channel filters as `` `property_id=in.(${propertyIds.join(',')})` ``.
  Swapping `computeAssignedPropertyIds()`'s derivation (currently: the
  crew member's own open turnovers/work orders) for a straight read of
  the PM's saved property-selection table is the direct template for
  every new sync helper this feature needs.
- **The shell/app-chrome pattern** — `app/crew/crew-shell.tsx`: sticky
  branded header, sync-status pill, `InstallBanner` component
  (`components/pwa/install-banner`), bottom nav, background sync loop
  (`processOutbox()` on mount / on `window 'online'` / every 30s), and
  `navigator.storage.persist()` to reduce IndexedDB eviction risk. All
  directly cloneable for a new shell.
- **Two manifest files already establish the template** —
  `public/manifest.json` (crew) and `public/dashboard-manifest.json`
  are byte-identical except `id`/`start_url`/`name`. A third
  (`public/pm-offline-manifest.json`, `start_url: "/pm-offline"` or
  similar) is a direct copy with new id/start_url — same icon set,
  colors, `display: "standalone"`.
- **RLS templates for the one new table needed** —
  `supabase/migrations/20260707145530_org_sms_templates.sql` (org-scoped,
  four explicit per-operation policies using `is_org_member()`) combined
  with `push_subscriptions`' per-user ownership policy
  (`USING (user_id = auth.uid())`) is exactly the shape for a new
  `pm_offline_property_selections` table — see schema below.

### What does not exist and is genuinely new work

- **Real offline-shell loading is 100% new, for either app.** A
  repo-wide search for `caches.open`, `workbox`, `CACHE_NAME`, or any
  `self.addEventListener('fetch'` returns zero matches anywhere in
  FieldStay today. `public/sw.js` only handles `push` and
  `notificationclick` — there is no app-shell precache, no
  fetch-interception, no Cache Storage usage. This means the crew app's
  own "yes, it works offline" claim is only true for pages/data already
  loaded into Dexie before connectivity dropped — a cold navigation
  with zero connectivity today falls back to whatever the browser's own
  HTTP cache happens to hold, which is unreliable. **Any real "open the
  installed app with no signal and see something" experience — for
  crew or this new PM app — requires adding actual `fetch`-event
  caching to the service worker.** This is foundational work, not a
  nice-to-have, and should be budgeted regardless of which offline
  feature ships first.
- **`maintenance_schedules` has no Dexie precedent to build on.**
  `lib/dexie/schema.ts`'s version history shows `maintenance_schedules`
  and `maintenance_completions` were stubbed in a `stores()` call at
  some point and explicitly *dropped* in schema version 4 as dead code
  ("never read or written anywhere in the crew app"). There is nothing
  to resurrect here — a maintenance Dexie table is genuinely new schema,
  not a re-enable.
- **A new property-selection table + settings page** (schema below).
- **A new route tree with its own layout-level auth gate.** The crew
  app's gate (`app/crew/layout.tsx`) is a bespoke inline check — session
  via `createClient()`, then a service-role lookup against
  `crew_members` — specifically built to reject PMs who wander into
  `/crew`. That pattern is wrong for this feature; the new route's
  `layout.tsx` should use the standard `requireOrgMember()` from
  `lib/auth.ts`, restricted to roles that actually manage maintenance/
  inventory (`admin`, `manager`, `owner` — not `viewer`, and not `crew`,
  which already has its own app).
- **New Dexie row types, richer than their crew equivalents.** The
  crew cache deliberately carries a *subset* of fields for tables it
  already syncs — e.g. `InventoryItemRow` (8 fields) vs. the real
  `InventoryItem` interface (15 fields: adds `catalog_item_id`,
  `low_stock_threshold_pct`, `is_active`, `preferred_brand`, `notes`,
  `first_count_recorded_at`); `ChecklistInstanceItemRow` is missing
  `is_mandatory`, `non_deletable`, `asset_discovery_type`, `notes` that
  the real `ChecklistInstanceItem` has. This PM-facing cache needs the
  fuller shape a PM actually edits from — but should **keep the same
  deliberate restriction on `PropertyAsset`'s financial fields**
  (`purchase_price`, `estimated_replacement_cost`, `macrs_class`,
  `depreciation_method`, `salvage_value`, `health_score`) that the crew
  cache already applies, since those aren't relevant to offline
  maintenance/inventory work and widen the exposure of cached data on
  a device for no operational benefit.
- **New outbox upload handlers.** `syncService.ts`'s `UPLOAD_HANDLERS`
  is a `Record<string, UploadHandler>` keyed by `` `${table}:${op}` `` —
  already a clean extension point, not a rewrite. New entries needed:
  `maintenance_schedules:PATCH` (edit a schedule), `work_orders:PUT`
  (create a WO offline, analogous to `uploadWorkOrderReport`),
  `inventory_items:PATCH` (already exists — reusable as-is if the
  richer row shape round-trips the same columns), `purchase_orders:PUT`
  or similar if offline PO creation is in scope for v1 (recommend
  deferring — see Phasing below).
- **UI**: offline-capable, property-filtered equivalents of the existing
  org-wide views. For scale context (line counts only, not depth-read):
  `maintenance-board.tsx` (2,137 lines), `inventory-manager.tsx` (1,428
  lines), plus the smaller per-property setup/builder pages (checklist,
  inventory, maintenance setup and template builders) — roughly 6,500
  lines of existing UI surface across 13 files that a PM-selected-
  properties offline view would need to parallel, filtered down, not
  necessarily reimplemented at the same scope or depth as the full
  admin views.

### Proposed schema addition

```sql
CREATE TABLE IF NOT EXISTS public.pm_offline_property_selections (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, property_id)
);

ALTER TABLE public.pm_offline_property_selections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON TABLE public.pm_offline_property_selections TO authenticated;

CREATE POLICY pm_offline_selections_select ON public.pm_offline_property_selections
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY pm_offline_selections_insert ON public.pm_offline_property_selections
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
    AND EXISTS (SELECT 1 FROM properties WHERE id = property_id AND org_id = pm_offline_property_selections.org_id)
  );

CREATE POLICY pm_offline_selections_delete ON public.pm_offline_property_selections
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_pm_offline_selections_user ON public.pm_offline_property_selections (user_id);
```

No `UPDATE` policy needed — the settings UI is add/remove rows, not
in-place edits.

### Settings page

Follows the exact pattern already established at
`app/(dashboard)/settings/integrations/` (`page.tsx` + `actions.ts`):
a Server Component calling `requireOrgMember()`, fetching the PM's
current selections + the org's full property list via a service client,
handing both to a client component; a single Server Action
(`updateOfflinePropertySelections(propertyIds: string[])`) re-derives
`requireOrgMember()` and upserts/deletes rows scoped to
`membership.org_id` and `user.id` — mirroring `triggerResync()`'s
role-gate idiom (`if (!['owner','admin','manager'].includes(membership.role))`).

### Sync engine changes

New sync helpers in `lib/dexie/sync/` (alongside the existing
`assets.ts`), each parameterized by the PM's selected `propertyIds`
(read from `pm_offline_property_selections` on mount, same as
`computeAssignedPropertyIds()` is read today) instead of a crew
assignment derivation:

- `syncMaintenanceSchedules(supabase, userId, propertyIds)` —
  `.from('maintenance_schedules').select(...).in('property_id', propertyIds)`
- `syncMaintenanceWorkOrders(supabase, userId, propertyIds)` — filtered
  work orders where `category` is maintenance-relevant
- `syncInventoryItems(supabase, userId, propertyIds)` — richer row shape
  than the crew cache (see above)
- `syncChecklistTemplates(supabase, userId, propertyIds)` — org-wide
  templates plus property-specific overrides

Selection changes need a **reconciliation step**, not just a re-fetch:
when the PM adds a property, hydrate it into Dexie immediately (if
online); when they remove one, prune its rows from IndexedDB. This is
a diff against the previous `propertyIds` set, not new sync-engine
architecture — same order of complexity as what already exists in
`context.tsx`'s generation-token-guarded refresh functions.

### Phasing recommendation

1. **Phase 0 — done.** `public/sw.js` now has a real `fetch`-event
   handler: network-first with cache fallback for navigations, cache-first
   for immutable `/_next/static/` assets, and a branded `public/offline.html`
   fallback for a URL that was never successfully visited on the device.
   `caches.delete()` for both cache names was added to the crew app's
   logout flow (`crew-shell.tsx`), mirroring `closeDexieDb()`'s "no
   residual data on a shared device" principle. One real bug surfaced and
   was fixed along the way: `/offline.html` needed its own entry in
   `proxy.ts`'s `BYPASS_ROUTES` — as a new static file with no bypass, it
   was being redirected to `/login` by the auth middleware, which defeats
   the entire point of an offline fallback page. Verified end-to-end via
   Playwright with real network-failure simulation (not `context.setOffline()`,
   which didn't actually block this service worker's own `fetch()` calls
   to localhost in this environment — route-based abort() was the
   reliable way to test it). This groundwork benefits the crew app
   immediately, not just this proposed feature.
2. **Phase 1:** read-only offline — property selection settings page,
   new Dexie tables, sync helpers, shell/manifest/route tree. PM can
   view (not edit) maintenance schedules, inventory levels, and
   checklists for selected properties while offline.
3. **Phase 2:** writes — inventory count updates and checklist
   completions first (lowest-risk, no cascading automation), via new
   `UPLOAD_HANDLERS` entries.
4. **Phase 3 (higher-risk, recommend deferring further):** offline
   creation of work orders and maintenance schedule edits, since these
   are the writes most likely to trigger vendor-facing automation
   (auto-assign suggestions, vendor notifications) with a potentially
   long delay between the offline edit and the eventual sync — worth a
   deliberate UX decision (e.g. a visible "will notify vendor once
   synced" indicator) before shipping, not just an engineering task.

### Open questions before implementation starts

- Should Phase 3 writes be blocked entirely while offline (view-only
  for anything with vendor-facing side effects), or allowed with a
  clear "pending" state? This is a product decision, not an
  engineering one.
- Multi-PM conflict handling: two PMs both offline-editing the same
  selected property is a smaller-blast-radius version of a problem the
  crew app doesn't really have (crew members don't share assignments).
  Needs at least a "last write wins, but show what changed" story
  before Phase 2 ships.
- Confirm which roles beyond admin/manager should have access — the
  proposed RLS above includes `owner`, but this should be a deliberate
  choice, not a default.

### Related housekeeping noticed during scoping

- `FUTURE_REMEDIATION.md` entry #2 (`SyncEngine.uploadOne()` growing via
  flat if-chains) is now **stale** — the dispatch has already been
  refactored into the `UPLOAD_HANDLERS` lookup map described above.
  Worth a follow-up pass to correct or remove that entry.

---

## 2. Modular room-based turnover checklist templates

**Concept:** replace the current per-property, hand-typed checklist with
reusable **room templates** (e.g. "Standard Bedroom," "Deluxe Bathroom")
that a PM composes a property's checklist out of — pick a room type, set
how many the property has (Bedroom × 3, Bathroom × 2, Screen Porch × 1),
and the property's actual checklist sections/items get generated from
those modules. Editing a room module later can be pushed out to every
property still using it, instead of a PM hand-editing the same task
across dozens of properties independently — which is exactly the problem
today, since every property's checklist is a fully independent copy with
no ongoing link to anything, from the moment it's created.

### The key finding that shrinks this a lot

The instance-level fields that make checklist items special —
`is_mandatory`, `non_deletable`, `asset_discovery_type` (Progressive
Asset Discovery's system-injected tasks), `photo_reason` (the Bayesian
dynamic-photo-requirement signal) — are **never part of the template at
all**. They're computed fresh at turnover-creation time from
`property_assets` and a separate per-property learned-signal table
(`checklist_item_signals`), keyed by `property_id`, with zero dependency
on section/room structure. Same story for the mandatory-item PM-email
completion check (`lib/inngest/functions/turnover-events.ts`'s
`handleTurnoverCompleted`) — it queries `property_assets` directly, never
`checklist_instance_items.is_mandatory`. Same for crew Dexie sync (only
ever touches instance-level columns) and photo storage (keyed by
`turnover_id`, not template/room id).

**This means `lib/turnovers/generator.ts`'s `snapshotChecklist()` — the
function that clones a property's template into a live turnover — needs
zero changes.** It already just reads whatever rows are sitting in
`checklist_template_items` regardless of where they came from. Turnover
generation, the crew PWA, offline sync, photo capture, and mandatory-item
enforcement are all completely insulated from this redesign, as long as
a property's `checklist_template_items` end up with the same row shape
they have today — which they do, since nothing about that table changes.

### Schema

No need for the two new "top-level" tables originally proposed
(`property_templates`, `property_template_rooms`) — `checklist_templates`
already is a property's blueprint record, and `checklist_template_sections`
already is the per-room row within it (`name`, `sort_order`). It just
needs a pointer to a reusable module:

```sql
CREATE TABLE room_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,              -- 'Standard Bedroom'
  auto_include boolean NOT NULL DEFAULT false, -- e.g. 'Whole Home' — seeded on every property automatically, not via the quantity picker
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_template_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_template_id uuid NOT NULL REFERENCES room_templates(id) ON DELETE CASCADE,
  task             text NOT NULL,
  requires_photo   boolean NOT NULL DEFAULT false,
  notes            text,
  sort_order       int NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE checklist_template_sections
  ADD COLUMN room_template_id uuid REFERENCES room_templates(id) ON DELETE SET NULL,
  ADD COLUMN room_synced_at   timestamptz;
```

RLS on the two new tables mirrors `org_master_checklist_items`'s existing
policy shape exactly: direct `org_id`, `is_org_member(org_id,
ARRAY['admin','manager','owner'])` for writes, `org_id IN (SELECT
get_user_org_ids())` for reads.

Existing sections all get `room_template_id = NULL` automatically —
purely additive, no backfill, no risk to existing property data.
`checklist_template_items` itself doesn't change shape at all; it just
gets *populated from* `room_template_items` instead of typed by hand
when a section is linked to a module.

### Property-setup UX

The property checklist-setup page shows every room template the org has
built, each with a quantity stepper (default 0). PM sets Bedroom → 3,
Bathroom → 2, Screen Porch → 1, Kitchen → 1, Dining Room → 1, leaves
everything else at 0. On save:
- One `checklist_template_sections` row gets created per unit — Bedroom
  × 3 creates 3 sections, each tagged `room_template_id` = the Bedroom
  module's id, auto-labeled "Bedroom 1"/"Bedroom 2"/"Bedroom 3" (renamable
  inline afterward, e.g. to "Primary Bedroom").
- Each new section's `checklist_template_items` gets populated by copying
  that room module's current `room_template_items`.
- Turning a quantity down removes the extra section(s).
- A "+ Add custom section" escape hatch stays available for a genuine
  one-off area not worth a shared module (a boat dock at one specific
  property) — that section just never gets a `room_template_id`,
  identical to how every section works today.

**Auto-include rooms.** Some modules (a "Whole Home" walkthrough) belong
on every property regardless of layout — not an opt-in quantity choice
like Bedroom or Screen Porch. A room template flagged `auto_include =
true` is excluded from the quantity-picker's list entirely and instead
seeded automatically: the checklist-builder's initial-sections computation
adds one section for any auto-include room not already present, on both a
brand-new checklist and an existing one that predates the room being
flagged. A PM can still detach/customize or delete that section like any
other — "automatic" means "seeded by default," not "locked."

### Bulk push — reuse the existing pattern, don't build a new one

The org already has a proven "push an update to every property" mechanism:
`lib/inngest/functions/apply-master-checklist.ts`, an Inngest-driven
batched fan-out (batched specifically to avoid a serverless timeout
looping over 20+ properties synchronously) backing today's "Apply Master
Checklist to Properties" button. Don't design a new bulk-update mechanism
for room templates — adapt this one. The only real difference: today's
version does a full delete-and-replace of a property's *entire* checklist
sourced from the flat `org_master_checklist_items` catalog; a room-level
version instead needs to touch only the sections tagged with a specific
`room_template_id` on each property (leave every other section alone),
sourced from `room_template_items`. Same event → batched-fan-out →
per-property-write shape, smaller/targeted blast radius per push. The
room library page gets the same "Apply to Properties" button the master-
checklist page has today, just living on each individual room template.

### The org-wide master checklist goes away

Once room templates + per-room push exist, `org_master_checklist_items`,
`master-checklist-builder.tsx`, `applyMasterChecklistToProperty()`, and
the whole "master checklist" concept are superseded — a PM building a
brand-new org's checklist library builds room templates directly instead
of a flat master list. This needs a plan for two things currently wired
to the old mechanism:

1. **New-property auto-seed.** `createProperty()`
   (`app/(dashboard)/properties/actions.ts`) and both PMS initial-sync
   functions (`lib/inngest/functions/ownerrez/initial-sync.ts`,
   `lib/inngest/functions/hospitable/initial-sync.ts`) currently call
   `applyMasterChecklistToProperty(..., { force: false })` to give a new
   property a non-empty starting checklist. Retiring the master checklist
   means deciding what replaces this — recommend a small org-level
   **default room quantities** preset (e.g. "every new property starts
   with Bedroom × 1, Bathroom × 1, Kitchen × 1, Living Room × 1"), applied
   automatically through the exact same room-instantiation logic the
   manual quantity-picker uses, rather than resurrecting a flat-list
   concept. A manually-added or PMS-synced property with zero rooms
   configured is a worse first impression than one pre-seeded with a
   sensible default a PM can then adjust.
2. **Migration for existing orgs.** Every org currently has real,
   populated `org_master_checklist_items` rows and real property
   checklists built from them. Retirement needs either a one-time
   conversion (group the org's existing master items by `section` name
   into equivalent `room_templates`, one room template per distinct
   section) or a decision to just leave existing data alone and only
   apply the new system going forward, with the old master-checklist UI
   kept around read-only (or removed) once every org has migrated.

### What does not need to change

Turnover generation (`snapshotChecklist`), crew PWA, Dexie sync, the
offline mutation outbox, photo capture/storage, the mandatory-asset-
discovery-item injection, and the PM completion-notification email — all
confirmed decoupled from template/section structure by the research above.

### What needs to change

- Migration + RLS (schema above)
- `types/database.ts` — new `RoomTemplate`/`RoomTemplateItem` interfaces,
  `room_template_id`/`room_synced_at` on `ChecklistTemplateSection`
  (worth fixing a pre-existing drift while in there:
  `checklist_template_sections.requires_section_photo` exists on the real
  table, added by `20260604223345_add_checklist_template_broadcasting.sql`
  and read/written by `lib/inngest/functions/checklist-broadcast.ts`, but
  was never added to the `ChecklistTemplateSection` TypeScript interface)
- A new Room Library settings page + Server Actions — structurally a
  clone of `app/(dashboard)/setup/checklist-template/`'s existing
  master-checklist builder (same replace-style RPC pattern, same CSV/DOCX
  import already built there)
- `app/(dashboard)/properties/[id]/setup/checklist/checklist-builder.tsx`
  — the quantity-picker UI, a linked-section indicator, and a way to
  detach a section from its module (clears `room_template_id`, keeps the
  items as a normal independent section)
- A new Inngest fan-out function adapted from
  `lib/inngest/functions/apply-master-checklist.ts`, scoped to one
  `room_template_id` instead of the whole checklist
- Eventually: retiring `org_master_checklist_items` +
  `master-checklist-builder.tsx` + `applyMasterChecklistToProperty()`,
  per the plan above

### Phasing

1. **Phase 1 (done)** — schema, Room Library CRUD, the property-setup
   quantity-picker (create/link/populate sections from modules on save),
   and the `auto_include` flag for rooms that belong on every property
   automatically. Fully additive; existing properties untouched. Seeded
   with the org's 14 standard modules (Bedroom, Bathroom, Kitchen, Laundry
   Room, Common Spaces, Dining Room, Breakfast Room, Office, Screen Porch,
   Patio/Deck, Pool, Pool House, Garage, and Whole Home — the last one
   `auto_include = true`).
2. **Phase 2** — the per-room bulk-push action (adapted
   `apply-master-checklist.ts`), "Apply to Properties" button on each
   room template.
3. **Phase 3** — retire the org-wide master checklist: default-room-
   quantities preset for new-property auto-seed, and a decision on
   migrating vs. freezing existing orgs' `org_master_checklist_items` data.

---

## 3. Offline-capable vendor work order completion

**Concept:** a vendor technician standing at a property with no signal
should be able to open a work order they're already on, build out line
items, attach photos, and mark it complete — with everything surviving a
dead connection and syncing automatically once signal returns, so nothing
falls through the cracks from a tech forgetting to go back and finish the
paperwork. **Invoicing/payment is explicitly out of scope** — this is
about the work-order-completion step only; whatever currently happens
after completion (invoice creation, Stripe payout) should keep firing
exactly as it does today, just reliably even when the completion itself
happened offline.

### The load-bearing fact that shapes everything else

**Vendors have no persistent identity of any kind.** No `user_id`, no
Supabase Auth session, no `organization_members` row — `member_role` has
no `vendor` value, and `Vendor` (`types/database.ts:321`) has no auth
link field at all. Every vendor interaction is an anonymous, single-token,
single-work-order session: a 64-char `completion_token`
(`work_orders.completion_token`, 30-day TTL) minted per-dispatch, matched
server-side via `createServiceClient()` (RLS bypass, since there's no
session to scope RLS to). There is no vendor login and no "vendor's
queue" — each dispatch is its own isolated link to exactly one WO.

This means **the crew PWA's offline stack is not a direct precedent to
extend** — it's a pattern to borrow the shape of, not code to reuse
as-is. `getDexieDb(userId)` bakes the user id straight into the IndexedDB
database name (`fieldstay-crew-${userId}`); there is no equivalent stable
identity for a vendor to key off, except the token itself. A vendor
offline store needs to be keyed **per-token** (one local database/scope
per work-order dispatch), not per-user. Practically: a vendor reopening
the same link on the same device continues from local cache correctly;
switching devices starts fresh (no cross-device vendor account to sync
against) — almost certainly fine, since one WO is worked by one tech on
one device.

### Which live flow this actually is (don't scope against the wrong one)

There are **two parallel vendor-facing systems** in the codebase today,
and only one is reachable:

- **`app/work-orders/[token]/page.tsx` + `vendor-portal.tsx`** — the real,
  live flow. Dispatched by `dispatchWorkOrderToVendor`
  (`app/actions/work-order-public.ts`), keyed on `completion_token`.
  Completion is a **single atomic submit**: the vendor builds line items
  as local React state, then one `POST /api/work-orders/[token]/complete`
  call sends everything at once. **No photo upload exists on this path
  at all today.**
- **`app/(public)/wo/[token]`** — a richer-looking flow with photo upload
  and a sign-off flow (`submitWorkOrderSignOff`), keyed on
  `work_orders.public_token`. **Nothing in the codebase ever wrote
  `public_token`** — this route was unreachable in production, forward-
  scaffolding for a documented future "TradeSuite" standalone product
  (`FIELDSTAY_MASTER_ROADMAP.md`, P11, July 2026). Removed entirely
  (2026-07-19): the route, `getWorkOrderByToken`/`submitWorkOrderSignOff`,
  the `work-order/signed-off` Inngest event + handler, and the `/wo/`
  entries in `proxy.ts`/`session-refresh-guard.tsx`. `dispatchWorkOrderToVendor`
  (the live `completion_token` flow) was untouched. The `public_token`-
  family columns on `work_orders` were deliberately left in the schema —
  removing them is a separate, more sensitive migration decision, not
  bundled into this cleanup.

### What "offline" actually needs to change about the completion model

Today's completion is "fill out the whole form once, submit once, done"
— not an incremental multi-step save. Recommended approach: keep that
shape rather than inventing a real-time incremental-sync API surface.
Make the **session itself** local-first (line items, notes, and photos
accumulate in local storage while the tech works, survives the tab dying
or losing signal mid-edit), and only the final "mark complete" tap
triggers a sync-and-submit — which itself needs to be queued/retried if
offline at that exact moment. This matches the literal ask ("fill out the
line items, mark it complete... it will sync") without requiring the
server to accept partial/incremental WO state, and sidesteps a real gap
found in the schema: `work_order_line_items` has **no dedup/uniqueness
constraint** — a naive retry-on-resync of an incremental-save API would
risk duplicate line items, whereas a single idempotent final-submit call
(with a client-generated idempotency key, same pattern already used for
`work-order-reports`) avoids that entirely.

### What's reusable from the crew PWA (pattern, not literal code)

- **The outbox shape** (`lib/dexie/syncService.ts`) — a local queue table,
  drained strictly in insertion order, retry-with-dead-letter thresholds
  (`retryCount &gt;= 3` → skip and continue draining, `&gt;= 5` → mark
  `failed` but keep the row so nothing vanishes silently). Directly
  applicable to queuing the final completion submit when it's attempted
  offline.
- **The generation-token race guard** (`lib/dexie/context.tsx`'s
  `refreshChecklistSubscription`/`refreshAssetsSubscription`) — needed if
  more than one trigger (a retry timer, an `online` event, a manual
  "retry now" tap) could attempt to sync the same local draft
  concurrently; increment-before-await, check-after-await prevents a
  stale attempt from clobbering a newer one.
- **The two-store photo pipeline** (`lib/dexie/photo-queue.ts` +
  `photo-sync.ts`) — compress-then-store-locally, upload-later, tracked
  via a separate metadata row. Needs a new `ALLOWED_TARGETS` entry for
  `work_order_photos` and **client-generated `crypto.randomUUID()`
  storage paths** — `work_order_photos.storage_path` has a **global**
  unique index (not scoped per WO), so a naive path scheme risks a real
  collision across queued offline photos.
- **`components/pwa/install-banner.tsx`** — generic, no crew-specific
  coupling, usable as-is if the vendor page should be installable.
- **`proxy.ts`'s bypass-list pattern** — a new manifest/service-worker
  registration point for the vendor route will need its own bypass
  entries, same as `/offline.html` needed one.

### What's genuinely new (nothing to extend)

- **Per-token local storage scope** — a new IndexedDB keying scheme,
  since `getDexieDb(userId)` has no vendor equivalent.
- **Service worker registration + a manifest for the vendor route** —
  `public/sw.js`'s fetch handler is already origin-wide, but nothing
  registers it on `/work-orders/[token]` today (registration only
  happens inside `crew-shell.tsx` and the PM dashboard's push-notification
  hook, neither of which a vendor's cold link-click ever mounts). Needs
  its own registration call and its own manifest (mirroring
  `dashboard-manifest.json`'s shape) if installability is desired.
- **Photo upload on the live vendor flow, period** — doesn't exist there
  today at all. Needs a new service-role Route Handler for the insert
  (RLS on `work_order_photos_insert` requires org membership vendors
  don't have — same reasoning as the existing completion route already
  using `createServiceClient()`).
- **An idempotency key on the completion submit** — a client-generated
  UUID sent with the offline-queued request and checked server-side,
  closing the line-item-duplication gap noted above. Mirrors the
  client-generated report ID fix already applied to work-order-reports
  elsewhere in this codebase.

### Side effects that must still fire correctly once synced (not touched, just preserved)

- Line items present → `work-order/invoice-submitted` → creates the
  `work_order_invoices` row (already idempotent via
  `upsert(onConflict:'work_order_id', ignoreDuplicates:true)`) → PM gets
  an "invoice ready" email. **This is the one hard dependency into the
  out-of-scope payment chain** — an offline-synced completion with line
  items must still trigger this, exactly once, or the vendor is never
  paid, even though the payment UX itself isn't part of this feature.
- No line items → `work-order/completed-via-portal` → PM notification
  only (confirmed: **no `owner_transactions` expense entry gets created
  in this branch today** — a pre-existing quirk, not something to "fix"
  as an incidental side effect of this work).
- Linked to a turnover → cascades `turnover/completed` as it does today.

### Open questions to decide before/during implementation (not solved here)

- **Vendor compliance re-check at sync time.** Nothing today — online or
  offline — re-checks `grace_period`/`hard_blocked` status at completion
  time (only WO *creation* gates on it, client-side only). A vendor who
  goes `hard_blocked` while working offline isn't blocked from completing
  today either way; decide whether this feature should add that check or
  explicitly leave the existing gap as-is.
- **Token expiry during an extended offline stretch.** `completion_token`
  has a flat 30-day TTL; a vendor offline for a long remote job could
  resurface post-expiry to a hard 410. Decide: extend the TTL, add a
  grace-sync window, or surface a clear "link expired, contact your PM"
  error while keeping the locally-captured draft intact (not deleted) so
  a PM-reissued fresh link could re-import it.
- **PM visibility into late/offline syncs.** Worth a notification (reuse
  the existing `notifications` table + `dedupe_key` pattern) when a WO
  completion syncs meaningfully after its actual completion timestamp, so
  a PM isn't surprised by a silent multi-day gap.
- **Rate limiting.** The completion route is IP-rate-limited (20/min,
  `workOrderRatelimit`), not token-rate-limited. Unlikely to matter for
  one vendor's one WO, but a burst of several queued photo uploads plus
  the final submit firing in quick succession on reconnect is worth a
  sanity check against the limiter.

### Suggested phasing

1. **Phase 1 — durable local draft, no server API changes.** Make the
   in-progress form itself resilient: line items/notes typed while
   offline survive a dead tab or lost signal, via a per-token local store.
   The final submit still assumes connectivity at the moment it's tapped.
   This alone fixes the most common failure mode (losing in-progress work
   to a closed tab or dead battery) without touching the completion API.
2. **Phase 2 — true offline submission.** Queue the final "mark complete"
   action itself when tapped offline (outbox-style), auto-retry on
   reconnect, with the client-generated idempotency key to prevent
   duplicate line-item inserts on retry.
3. **Phase 3 — offline photo capture.** Net-new capability on the live
   vendor portal: compress-and-queue-locally, upload-later, using the
   crew PWA's two-store pattern and collision-safe UUID storage paths.
4. **Phase 4 (optional) — PM-facing visibility** into late/offline syncs,
   plus resolving the token-expiry-while-offline question.
