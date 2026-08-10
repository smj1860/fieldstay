# Dynamic PAR Engine — port state & open design

Handoff written 2026-08-10 at the end of a long session. Everything below is
verified against the live code and databases unless explicitly marked as a
decision or an open question.

**Read this first, then `FUTURE_REMEDIATION.md` items 31 and 32.**

---

## 1. What this is, and why it matters

A self-adjusting inventory par system. In the product owner's words:

> I want to be able to go into the templates in admin, put in a FieldStay
> standard inventory template with pars already set based on average usage,
> and the system set up so that when the template is used — or when **any**
> inventory template is created and used, not just that one — the par system
> self-adjusts based on previous inventory counts, max guests, and rooms.

That "not just that one" is the load-bearing requirement, and the
implementation genuinely satisfies it. Par config propagates:

```
inventory_catalog  (platform/admin master)
  └─> org_inventory_catalog        (seeded per org, lib/inventory/seed-org-catalog.ts)
        └─> inventory_template_items   (ANY org template — inherits unless overridden)
              └─> inventory_items       (property level — inherits; recompute fires on apply)
```

So an admin setting a catalog item to `smart` makes every downstream template
and property item self-adjust, including templates a PM builds themselves.

---

## 2. Where the code is RIGHT NOW

Branch `claude/hostile-code-audit-rbz3f8`, pushed. Two relevant commits:

| Commit | Contents |
|---|---|
| `722c17ba` | `lib/inventory/par-engine.ts` + `unit/inventory/par-engine.test.ts` (14 tests, green) |
| `d584a2a1` | The schema migration, applied to BOTH databases + `FUTURE_REMEDIATION` 32 |

### Applied to the live databases

`supabase/migrations/20260810214329_dynamic_par_engine_schema.sql` is applied
to **production** (`vpmznjktllhmmbfnxuvk`) and **E2E**
(`syhthijeqlnltufdawyb`).

Post-apply verification against production: `par_mode` present on 5 tables,
`inventory_consumption_stats` exists with RLS enabled, 1 policy, 3 indexes,
and **0 of 147 catalog rows are non-static** — i.e. no behaviour changed.

> **The ledger/file parity trap — read before applying the next migration.**
> There is no Supabase CLI and no `SUPABASE_ACCESS_TOKEN` in the agent
> environment, so migrations must go through the MCP `apply_migration`. **MCP
> assigns its own version and a different one per call.** The same migration
> landed as `20260810214329` on E2E and `20260810214410` on prod, while the
> local file said `20260810120000` — three versions for one migration, which
> is the exact drift that put production at 36/35 divergences in audit H10.
>
> It was reconciled by hand: prod's ledger row was UPDATEd to E2E's version
> and the local file renamed to match. **Do the same for the next two:** apply
> to E2E, read the recorded version, apply to prod, normalise prod's row to
> E2E's version, rename the local file. Then `pnpm run check:migration-ledger:prod`.

### Parked, NOT applied, NOT committed

These two are in the session scratchpad only (they will be lost — regenerate
them from the source branch if needed):

- `20260810130000_dynamic_par_engine_pipeline.sql`
- `20260810140000_dynamic_par_engine_platform_template_rpc.sql`

Source branch for everything: **`origin/claude/migration-reconciliation-5is9pq`**
(misleadingly named — it was reused after PR #539; it actually contains the
5 PAR commits). Original spec files: `CLAUDE_PAR_1/2/3.md`.

> The RPC migration's original version `20260730140000` **collides** with
> main's already-applied `20260730140000_atomic_subscription_plan_update.sql`.
> Left as-is, `db push` would silently skip the PAR RPC and the feature would
> ship with its RPC missing. It has been renumbered to `20260810140000`;
> keep it renumbered.

---

## 3. Four defects in the source branch — fix during the port

The feature's design is sound. Its data-layer plumbing predates the
2026-08-07/08 hardening passes and will fail current CI gates.

1. **The recompute writes nothing, silently.** `inventory-par-recompute.ts`
   does `.upsert(changedRows, { onConflict: 'id' })` where `changedRows` is
   `{id, par_level, par_resolved_at}`. `inventory_items` has three NOT NULL
   columns with no default — `name`, `org_id`, `property_id` — and Postgres
   validates NOT NULL when it forms the tuple, *before* it detects the
   conflict. Every recompute raises `23502`. The result is discarded, so it
   fails silently while returning `items_changed: changedRows.length`.
   **The engine would never update a single par level.** Fix: carry the
   required columns, or use a bulk `UPDATE ... FROM (VALUES ...)` RPC.

2. **Three unbounded `.select()`s in a new `lib/inngest/` file.**
   `unbounded-select.test.ts` grandfathers a BASELINE; new files must comply.
   `fetch-scope` is a real defect — with `property_id` omitted it is an
   org-wide read that truncates at 1000 properties.

3. **Four discarded read/write results.** `discarded-result` and
   `read-without-error` are both at **0** in `.semgrep/baseline-counts.json`.
   These push both off zero, which the ratchet forbids outright.

4. **`PropertyRow` lies about nullability.** It types `bedrooms`/`max_guests`
   as non-null `number` behind an `as PropertyRow[]` cast; both are nullable
   in the DB. The resolver guards at runtime, so it is a wrong type rather
   than a live bug.

### One spec task is dead

PAR_2 Task 6B wires consumption capture into `approveInventoryCount` on the
inventory-count **draft** path. That whole family was dropped by
`20260804125424_drop_inventory_count_drafts.sql` and `approveInventoryCount`
no longer exists. **Drop task 6B.** Task 6A's path
(`handleInventoryCountSubmitted`) is alive and becomes the only consumption
source.

### An expired constraint (good news)

PAR_1 and PAR_2 both say *"DO NOT run `db push` or `apply_migration` —
migration reconciliation is unresolved."* That is why this feature sat frozen.
Reconciliation completed 2026-08-03 at 313/313 parity with a CI gate. **The
constraint no longer applies.**

---

## 4. Type-generation ordering (this blocks the port)

`lib/supabase/server.ts` wires `createServerClient<Database>`, so `.select('*')`
infers from `types/database.generated.ts`, which is generated from the live
schema. Sequence is therefore forced:

```
apply migration -> regenerate types/database.generated.ts -> update types/database.ts -> code compiles
```

`types/database.ts` was deliberately NOT updated in `d584a2a1`: nothing
selects the new columns yet, and declaring them before the generated file
knows about them breaks `.select('*')` inference (it did — `app/(dashboard)/
inventory/page.tsx`'s `type InventoryItemRow = InventoryItem & {…}` failed
tsc). The schema is now applied, so regeneration is unblocked. Note the
regenerated file is ~6,000 lines and will consume a lot of context.

---

## 5. The engine as built

`lib/inventory/par-engine.ts` — pure, synchronous, total (never throws).

```
par_mode 'static'  -> stored par_level returned unchanged
par_mode 'smart'   -> 1. historical, if auto_adjust AND sample_count >= 3
                      2. else smart-group formula
```

- `smart_formula` = `ceil(base_qty × property[multiplier] × (1 + buffer))`
- `historical` = `ceil(rate_per_guest_night × max_guests × avg_stay_length × 1.20)`, floor 2

| Group | Scales by | Buffer |
|---|---|---|
| `bathroom_essential` | `properties.bathrooms` | +15% |
| `bedroom_essential` | `properties.bedrooms` | +20% |
| `guest_consumable` | `properties.max_guests` | +10% |

**Both branches compute ONE STAY.** This is the single most important fact for
the sheet work below: `base_qty` must mean *per unit, per stay*. If coverage
is baked into `base_qty` instead, then the moment an item reaches 3 samples
the historical branch takes over and computes ~3× smaller — pars would
visibly collapse on exactly the items that are working best.

Deferred to **Pass 4** (per the spec, do not build now): per-reservation guest
counts — add `bookings.guest_count` from OwnerRez/Hospitable mappers and
switch both the consumption recorder and `historicalPar` off the
`max_guests × avg_stay_length` proxy **in the same pass**, since the proxy
must change on both sides together.

---

## 6. The seed sheet

`fieldstay_inventory_seed_addition.xlsx` / `.csv` — 133 rows.
Columns: `Name, Category, Unit, Par Level, Per Bedroom, Per Bathroom,
Description, Active, Brand-Essentials, Brand-Standard, Brand-Premium`.

Data is clean: **zero** rows set both Per columns, every row has some par.

### Mapping to the schema

| Sheet | Schema |
|---|---|
| `Per Bathroom` filled (14 rows) | `par_mode='smart'`, `smart_group='bathroom_essential'`, `base_qty` = value |
| `Per Bedroom` filled (10 rows) | `par_mode='smart'`, `smart_group='bedroom_essential'`, `base_qty` = value |
| neither (109 rows) | `par_mode='static'`, `default_par_level` = `Par Level` |

Two rows carry both a `Par Level` and a Per value (Disposable Razor,
Shampoo Bulk). Not a conflict — the schema keeps `default_par_level` as the
static fallback alongside smart config.

### The owner's methodology — CONFIRMED, and not uniform

This was never written on the sheet. Captured verbatim:

- **Towels and such** — per guest per stay, plus a little extra, *because they
  are laundered*. **No multi-stay coverage.**
- **Sheets and pillows type items** — per bed, plus a spare.
- **Welcome pack** — per stay, regardless of guest count.
- **K-cups** — "not actually enough quantity, but supposed to be enough for
  3 stays."
- **Toilet paper type items** — same, 3 stays.

The numbers decode against this exactly:

| Item | Sheet | Decodes as |
|---|---|---|
| Toilet Paper | 18 | 1/guest × 6 guests × **3 stays** ✔ |
| Bath Towels | 12 | 2/guest × 6 guests, **no coverage** (laundered) ✔ |
| Coffee Welcome Pack | 4 | 1/stay × **4 stays** ✔ |
| Pool Towels | 10 | ~1.5/guest × 6, no coverage ✔ |

### Proposed `Per Guest` column (per guest, PER STAY — no coverage baked in)

| Item | Per Guest | Notes |
|---|---|---|
| Bath Towels | 2 | laundered — no coverage |
| Pool Towels | 1.5 | laundered |
| Beach Towels | 1 | laundered |
| Toilet Paper | 1 | **consumable — needs 3× coverage** |
| Paper Cups | 4 | consumable |
| Coffee K-Cup | 3 | consumable |
| Drinking Glasses | 2 | reused |
| Wine Glasses | 1 | reused |
| Outdoor Drinkware | 1 | reused |

**Excluded and why:** Coffee Welcome Pack and (probably — CONFIRM) Local Snack
Assortment are *per stay*, not per guest. All of Cleaning, Laundry,
Maintenance & Safety and the Kitchen durables are per-turnover or equipment —
they scale with the property, not headcount.

**Pack-unit items are unresolved.** Bottled Water, Napkins, Chocolates,
Sugar/Sweetener and Paper Plates are measured in *packs*, so per-guest lands
at fractions like 0.08 and `ceil()` flattens every property onto "1 pack".
Left static. Fixing this means a unit change (bottles, not packs) — a data
decision for the owner.

---

## 7. Design gaps the sheet exposed

The engine models **one** attribute (what an item scales by). The owner's
methodology needs **three**. All three are cheap to add now while the schema
is days old; each is an enum-and-column migration later.

1. **A per-stay dimension.** A welcome pack scales with turnover frequency,
   which none of the three groups express. Proposed fourth group
   `stay_essential`, `base_qty` 1, resolving to `ceil(coverage_stays × base_qty)`.
   Today the only encoding is `static`, where the number *is* the coverage
   count — which is what the owner did, but it means the coverage factor is
   hand-typed into every such item and item 32's setting will never reach them.

2. **Consumable vs reused — the gate on coverage.** This is the important one.
   If item 32 multiplies every smart par by 3–4 stays, toilet paper goes
   7 → 23 (right) but **bath towels go 14 → 49** (absurd — they are
   laundered). Proposed: a `consumable` boolean, with
   `par = base × multiplier × (consumable ? coverage_stays : 1)`.

3. **Rotation / spare for linens.** "Per bed plus a spare" is a third shape —
   neither scaling nor coverage. May be expressible as `base_qty` rounding
   (2 sets per bed rather than 1), or may want its own term. **Open.**

---

## 8. Open questions for the owner

1. Is **Local Snack Assortment** per-stay (like the welcome pack) or per-guest?
2. Add the fourth `stay_essential` group? (recommended — cheap now)
3. Add the `consumable` flag? (**strongly** recommended — without it, item 32
   would tell PMs to stock 49 bath towels)
4. Do the pack-unit items get a unit change so they can scale?
5. Is the seed sheet an **addition** to the existing 147 catalog items, or a
   **replacement**? Name-overlap has not been checked yet.
6. **Sequencing:** land item 32's coverage multiplier *before* flipping
   consumables to smart? Otherwise toilet paper visibly drops 18 → 7 in the
   UI until item 32 ships. Reusables are unaffected either way.
7. Brand tiers (`Brand-Essentials/Standard/Premium`) have no schema support —
   only a singular `preferred_brand` exists. All three columns are empty in
   the current file. Separate pass.

---

## 9. Suggested order of work

1. Regenerate `types/database.generated.ts`, update `types/database.ts`.
2. Decide gaps 1–3 above; if adding the group/flag, do it as ONE migration now.
3. Apply + reconcile the pipeline and RPC migrations (see the parity trap in §2).
4. Port PAR_2 (recompute + consumption recorder + wiring), **fixing all four
   defects in §3 and dropping task 6B**.
5. Port PAR_3 (admin catalog UI, admin templates, org master list, par-levels
   browser + explainability).
6. Load the seed sheet.
7. Full gate: `tsc`, `vitest run`, `npm run lint` (ratchet 181), `check:ui-classes`,
   semgrep chokepoints + ratchet, `next build`, `check:migration-ledger:prod`.

Verification standard used throughout this session: **canary every guardrail
by breaking the thing it protects**, and verify claims against the live
database rather than the spec — every spec in this repo has had at least one
premise that expired.
