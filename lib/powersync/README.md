# PowerSync — Local-First Sync Layer

This directory contains all PowerSync configuration for FieldStay's local-first architecture.

| File | Purpose |
|---|---|
| `schema.ts` | Client-side SQLite table definitions — what columns exist in the local DB |
| `client.ts` | `SupabaseConnector` (auth + upload handler) and `getPowerSyncDb()` singleton |
| `sync_rules.yaml` | Bucket definitions — what rows from Supabase sync down to each user's device |

---

## How It Works

PowerSync maintains a local SQLite database on each crew member's device. Reads come from SQLite (zero latency, works offline). Writes go through `SupabaseConnector.uploadData()`, which routes each operation to the appropriate Supabase table or API endpoint. PowerSync then streams the server's authoritative response back down, keeping the local DB current.

```
Crew device (SQLite)
    ↕  sync rules / JWT
PowerSync Cloud
    ↕  replication
Supabase PostgreSQL (RLS enforced)
```

The JWT passed to PowerSync on connect is the user's Supabase session access token. `request.user_id()` in sync rules resolves to the JWT `sub` claim, which equals `auth.users.id` and matches `crew_members.user_id`.

---

## Sync Rules DSL Constraints

PowerSync's sync rules YAML has strict limitations that differ from standard SQL. These were learned through direct validation and are documented here to prevent future wasted effort:

| Constraint | Parameter queries | Data queries |
|---|---|---|
| Single table only — no JOINs | ✅ Required | ✅ Required |
| No subqueries | ✅ Required | ✅ Required |
| `request.user_id()` available | ✅ Yes | ❌ No |
| `bucket.<param>` references | ❌ No | ✅ Yes |
| Cross-bucket parameter chaining | ❌ Not supported | — |

**Views cannot be added to the `powersync` publication.** Postgres logical replication does not support views. Any helper object that needs to be queryable from sync rules must be a real table in the publication.

**The consequence of all of the above:** multi-hop relationships (user → crew_member → turnover → checklist_item) cannot be resolved at sync-rule query time. They must be pre-resolved as denormalised columns on published tables, kept current by Postgres triggers.

---

## Denormalised Columns (Do Not Remove)

Three columns were added specifically to satisfy PowerSync's single-table constraint. They are maintained by triggers and must not be removed or their triggers disabled.

### `turnover_assignments.user_id`
- **Source:** `crew_members.user_id`
- **Purpose:** Allows `SELECT turnover_id FROM turnover_assignments WHERE user_id = request.user_id()` — the primary parameter resolution for turnovers, properties, and inventory buckets
- **Triggers:**
  - `trg_populate_turnover_assignment_denorm` (BEFORE INSERT on `turnover_assignments`) — populates both `user_id` and `property_id` from the crew member and turnover records on new assignments
  - `trg_sync_turnover_assignment_user_id` (AFTER UPDATE OF user_id ON `crew_members`) — keeps in sync if a crew member's user account changes

### `turnover_assignments.property_id`
- **Source:** `turnovers.property_id`
- **Purpose:** Allows `SELECT property_id FROM turnover_assignments WHERE user_id = request.user_id()` for the properties and inventory parameter queries without a JOIN
- **Triggers:**
  - `trg_populate_turnover_assignment_denorm` (same as above — populates on INSERT)
  - `trg_sync_turnover_assignment_property_id` (AFTER UPDATE OF property_id ON `turnovers`) — keeps in sync if a turnover is moved to a different property

### `checklist_instance_items.turnover_id`
- **Source:** `checklist_instances.turnover_id`
- **Purpose:** Allows `SELECT ... FROM checklist_instance_items WHERE turnover_id = bucket.turnover_id` without a JOIN through `checklist_instances`
- **Trigger:**
  - `trg_populate_checklist_item_turnover_id` (BEFORE INSERT on `checklist_instance_items`) — populates from the parent `checklist_instances` row on creation

---

## Synced Tables

### `turnovers`
**Tenant filter:** `turnover_assignments.user_id = request.user_id()` (via denormalised column)

Crew members see only turnovers they are assigned to via `turnover_assignments`. Not all org turnovers.

**Synced columns:** `id`, `property_id`, `org_id`, `checkout_datetime`, `checkin_datetime`, `window_minutes`, `status`, `priority`, `notes`

**Upload behavior in `client.ts`:**
- `status = 'completed'` → routed to `POST /api/crew/turnovers/[id]/complete` — fires `turnover/completed` Inngest pipeline (cleaning fee, PM notification, duration tracking). **Never a direct table write.**
- `status = 'in_progress'` → routed to `POST /api/crew/turnovers/[id]/start` — sets `started_at` server-side. **Never a direct table write.**
- Any other status → direct Supabase update, `status` field only

> **Critical:** Do not add direct `status = 'completed'` or `status = 'in_progress'` writes anywhere in the crew app. The Route Handlers are the only authorized paths for those transitions.

---

### `checklist_instances`
**Tenant filter:** `turnover_id = bucket.turnover_id` (resolved from `turnover_assignments`)

**Synced columns:** `id`, `turnover_id`, `org_id`, `status`

**Upload behavior:** Read-only from the crew app. Status is derived from item completion.

---

### `checklist_instance_items`
**Tenant filter:** `turnover_id = bucket.turnover_id` (via denormalised column — no JOIN needed)

**Synced columns:** `id`, `instance_id`, `turnover_id`, `section_name`, `task`, `is_completed`, `completed_at`, `requires_photo`, `photo_storage_path`, `crew_notes`, `sort_order`

**Upload behavior:** `PUT` operations update `is_completed`, `crew_notes`, and `photo_storage_path` only. `photo_storage_path` is set after a successful Supabase Storage upload — the upload itself goes directly to Storage, not through PowerSync.

---

### `properties`
**Tenant filter:** `property_id = bucket.property_id` (resolved from `turnover_assignments.property_id`)

Crew members see only properties tied to their assigned turnovers.

**Synced columns:** `id`, `org_id`, `name`, `address`, `city`, `state`

**Intentionally excluded:** `door_code`, `wifi_password`, `wifi_name`, `access_instructions`, `checkin_time`, `checkout_time`, `internal_notes`, all financial fields (`cleaning_cost`, `avg_nightly_rate`, etc.), `owner_id`. Crew needs name and address to navigate — nothing more. The column whitelist in the sync rule data query is the enforcement mechanism.

**Upload behavior:** Read-only. No client writes to this table.

---

### `inventory_items`
**Tenant filter:** `property_id = bucket.property_id` (resolved from `turnover_assignments.property_id`)

Only items for properties the crew member is assigned to. Active items only (`is_active = true`).

**Synced columns:** `id`, `property_id`, `org_id`, `name`, `category`, `unit`, `par_level`, `current_quantity`

**Upload behavior:** `PUT` operations update `current_quantity` only. Crew adjusts stock counts on-site; changes sync via PowerSync and post to the server as a draft inventory count.

---

### `crew_availability`
**Tenant filter:** `org_id = bucket.org_id` (resolved from `crew_members.org_id` via `request.user_id()`)

Org-scoped — crew members see availability for their whole org (needed for the availability calendar).

**Upload behavior:** Read-only from the crew turnover app.

---

### `messages`
**Tenant filter:** `org_id = bucket.org_id` (resolved from `crew_members.org_id` via `request.user_id()`)

Org-scoped at the sync layer. RLS on the `messages` table provides the secondary sender/recipient boundary at the database layer — a crew member whose session reaches Supabase directly cannot read another crew member's messages.

**Synced columns:** `id`, `org_id`, `sender_id`, `recipient_id`, `content`, `read_at`, `turnover_id`, `created_at`

**Upload behavior:** Crew members send messages through a Server Action. Incoming messages are read from local SQLite via `usePowerSyncQuery`.

---

## Columns Intentionally Excluded From Sync

Never add these to `schema.ts`. Adding them requires explicit architectural review.

| Category | Examples | Reason |
|---|---|---|
| Access credentials | `door_code`, `wifi_password`, `gate_code` | Security — crew gets these verbally or via a separate secure channel |
| Financial data | `cleaning_cost`, `avg_nightly_rate`, `owner_payout` | Crew has no need for financials |
| Owner PII | `owner_id`, `owner_email`, `owner_phone` | Not relevant to crew operations |
| Service role artifacts | `stripe_customer_id`, `vault_secret_id` | Must never leave the server |
| Vendor compliance | `coi_expiry`, `license_number` | PM-only data |
| Audit fields | `audit_events.*` | Server-only |

---

## Write Path Rules

`uploadData()` in `client.ts` is the only place client-originated writes are processed. The rules are:

1. **`turnovers` PUT, `status = 'completed'`** → `POST /api/crew/turnovers/[id]/complete` only
2. **`turnovers` PUT, `status = 'in_progress'`** → `POST /api/crew/turnovers/[id]/start` only
3. **`turnovers` PUT, any other status** → direct Supabase update, `status` field only
4. **`checklist_instance_items` PUT** → direct Supabase update, fields `is_completed`, `crew_notes`, `photo_storage_path` only
5. **`inventory_items` PUT** → direct Supabase update, field `current_quantity` only
6. **Any other table or operation** → currently ignored. If you add a new writable table, add an explicit handler. Never add a catch-all.

---

## Sync Rules File (`sync_rules.yaml`)

`sync_rules.yaml` is the source-of-truth for what data syncs to each device. It lives here for version control but is applied by pasting into the PowerSync Cloud dashboard for the project at `NEXT_PUBLIC_POWERSYNC_URL`.

**Changes to `sync_rules.yaml` must be applied manually in the dashboard after merging.** There is no automated deployment. Update the `# Last applied:` date at the top of the file after each deployment.

### Changing sync rules

Before modifying `sync_rules.yaml`:

1. Re-read the DSL constraints table at the top of this document — the rules are stricter than they look.
2. If you need to filter by a relationship that spans multiple tables, the only valid approach is a denormalised column with a trigger (see the Denormalised Columns section above). Views cannot be published. Cross-bucket chaining does not work.
3. Write the new bucket definition and validate it in the PowerSync dashboard before merging.
4. After the PR merges, deploy to the dashboard and update the `# Last applied:` date.
5. Test on a real device that a crew member in Org A cannot see data from Org B.

### Changing upload behavior

Before adding a new writable table or field to `uploadData()`:

1. Confirm the write does not need to trigger any Inngest workflow. If it does, route through a Route Handler (see turnovers `completed` and `in_progress` as the pattern).
2. Confirm the field is safe to accept from a client-controlled source. Direct writes rely entirely on RLS being correct.
3. Add the handler explicitly. Never use a catch-all.

---

## Open Findings

All previously tracked findings are resolved.

| Finding | Resolution |
|---|---|
| `properties` missing `org_id` in schema | ✅ Resolved — `org_id` added to `schema.ts` |
| `checklist_instances` missing `org_id` in schema | ✅ Resolved — `org_id` added to `schema.ts` |
| `inventory_items` missing `org_id` in schema | ✅ Resolved — `org_id` added to `schema.ts` |
| `sync_rules.yaml` not version controlled | ✅ Resolved — file committed to `lib/powersync/sync_rules.yaml`, validated and deployed |
| Static `powersync_crew_*` tables (stale, non-functional) | ✅ Resolved — tables dropped; denormalised columns + triggers replace them |
