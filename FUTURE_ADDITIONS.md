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
