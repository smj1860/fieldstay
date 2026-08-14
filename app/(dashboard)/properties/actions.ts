'use server'

import { revalidatePath } from 'next/cache'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { geocodeZip } from '@/lib/geocoding'
import { calculateHealthScore } from '@/lib/assets/health-score'
import { isDbEnum, toDbEnum } from '@/lib/db-enums'
import { doorCodeArgs } from '@/lib/properties/door-code'
import { logAuditEvent } from '@/lib/audit'
import { applyStandardInventoryToProperty } from '@/lib/inventory/apply-standard-to-property'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError, unwrapList, isRealQueryError } from '@/lib/supabase/unwrap'
import { parseMoneyAmount } from '@/lib/schemas/money'
import type { AssetType, AssetTypeStandard, Enums, MemberRole, TablesInsert } from '@/types/database'

// properties/property_assets both gate writes on
// is_org_member(org_id, ARRAY['admin','manager']) at the RLS layer, and
// store_property_door_code/read_property_door_code now gate on the same set
// (migration 20260731201000). Gating the Server Actions on the same roles
// means a `viewer` gets a real permission error instead of a write that
// silently matches 0 rows. is_org_member()/requireOrgRole() both pass `owner`
// automatically, so it need not be listed.
const PROPERTY_WRITE_ROLES: MemberRole[] = ['admin', 'manager']

// A write denied by RLS affects 0 rows and returns NO error, so `if (error)`
// alone reports success for a change that never happened. Every UPDATE in this
// file selects the touched row back and treats a null result as denial.
const NOTHING_UPDATED =
  'You do not have permission to make this change, or the record no longer exists.'

export type PropertyActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  success?: boolean
}

type ActionSupabase = Awaited<ReturnType<typeof requireOrgRole>>['supabase']

/**
 * Best-effort lat/lng write after a successful geocode. Reported, never fatal —
 * a property that otherwise saved must not fail over its map pin. It still
 * distinguishes "the write errored" from "the write matched 0 rows" instead of
 * discarding both, which is the silent-failure class this pass closed.
 */
async function writeCoords(
  supabase:   ActionSupabase,
  propertyId: string,
  coords:     { lat: number; lng: number },
  site:       string,
): Promise<void> {
  const { data, error } = await supabase
    .from('properties')
    .update({ lat: coords.lat, lng: coords.lng })
    .eq('id', propertyId)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error(`[${site}] geocode coordinate write failed`, error)
    reportError(error, { site: `serverAction.properties.${site}.writeCoords` })
    return
  }
  if (!data) {
    console.warn(`[${site}] geocode coordinate write matched 0 rows`, { propertyId })
  }
}

/**
 * store_property_door_code, with its error reported rather than discarded and
 * WITHOUT surfacing a user-facing failure — used only where the surrounding
 * write has already committed. Never logs the door code itself.
 */
async function reportDoorCodeWrite(
  supabase:   ActionSupabase,
  propertyId: string,
  orgId:      string,
  doorCode:   string | null,
  site:       string,
): Promise<void> {
  const { error } = await supabase.rpc(
    'store_property_door_code',
    doorCodeArgs(propertyId, orgId, doorCode)
  )
  if (error) {
    console.error(`[${site}] door code write failed`, error)
    reportError(error, { site: `serverAction.properties.${site}.storeDoorCode`, orgId })
  }
}

/**
 * A positive whole-number form field (bedrooms, guests, lifespan years).
 *
 * `parseInt(x) || fallback` was the previous shape, and it only looks like
 * validation: it catches NaN and 0 because both are falsy, and passes
 * NEGATIVES straight through because -5 is truthy. `bedrooms: -5` was storable.
 */
function positiveIntField(raw: FormDataEntryValue | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw as string, 10)
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback
}

/** Same, but optional — absent stays null; present-but-invalid is rejected. */
function optionalPositiveInt(
  raw: FormDataEntryValue | null,
  max: number,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === '') return { ok: true, value: null }
  const n = Number.parseInt(raw as string, 10)
  if (!Number.isInteger(n) || n <= 0 || n > max) return { ok: false }
  return { ok: true, value: n }
}

/**
 * An optional money field. Absent stays null; present-but-invalid is REJECTED
 * rather than coerced.
 *
 * The previous `formData.get(x) ? parseFloat(x) : null` had no guard at all:
 * NaN and ±Infinity both JSON-serialize to `null`, so a malformed price was
 * indistinguishable from an omitted one, and a NEGATIVE price stored as-is.
 * purchase_price and estimated_replacement_cost feed MACRS depreciation and
 * calculateHealthScore, so a negative there reaches the owner's tax schedule.
 */
function optionalMoneyField(
  raw: FormDataEntryValue | null,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === '') return { ok: true, value: null }
  const parsed = parseMoneyAmount(Number.parseFloat(raw as string))
  return parsed.ok ? { ok: true, value: parsed.amount } : { ok: false, error: parsed.error }
}

const MAX_BEDROOMS  = 50
const MAX_GUESTS    = 100
const MAX_BATHROOMS = 50
const MAX_LIFESPAN_YEARS = 100
const MAX_IMPORT_ROWS    = 500

interface PropertyFormFields {
  name:             string
  address:          string
  city:             string
  state:            string
  zip:              string
  property_type:    ReturnType<typeof toDbEnum<'property_type'>>
  bedrooms:         number
  bathrooms:        number
  max_guests:       number
  checkin_time:     string
  checkout_time:    string
  wifi_name:        string | null
  wifi_password:    string | null
  door_code:        string | null
  internal_notes:   string | null
  avg_nightly_rate: number | null
}

/**
 * Parses and validates the property form in one place, so createProperty stays
 * an orchestrator. Returns the first user-facing message rather than throwing.
 */
function parsePropertyForm(
  formData: FormData,
): { fields: PropertyFormFields } | { error: string } {
  const name = (formData.get('name') as string)?.trim()
  if (!name) return { error: 'Property name is required' }

  const rate = optionalMoneyField(formData.get('avg_nightly_rate'))
  if (!rate.ok) return { error: `Nightly rate: ${rate.error}` }

  const bathroomsRaw = Number.parseFloat(formData.get('bathrooms') as string)
  const bathrooms =
    Number.isFinite(bathroomsRaw) && bathroomsRaw > 0 && bathroomsRaw <= MAX_BATHROOMS
      ? bathroomsRaw
      : 1

  return {
    fields: {
      name,
      address:          (formData.get('address') as string)?.trim(),
      city:             (formData.get('city') as string)?.trim(),
      state:            (formData.get('state') as string)?.trim(),
      zip:              (formData.get('zip') as string)?.trim(),
      property_type:    toDbEnum('property_type', formData.get('property_type') as string | null, 'house'),
      bedrooms:         positiveIntField(formData.get('bedrooms'), 1, MAX_BEDROOMS),
      max_guests:       positiveIntField(formData.get('max_guests'), 2, MAX_GUESTS),
      bathrooms,
      checkin_time:     (formData.get('checkin_time') as string) || '15:00',
      checkout_time:    (formData.get('checkout_time') as string) || '11:00',
      wifi_name:        (formData.get('wifi_name') as string)?.trim() || null,
      wifi_password:    (formData.get('wifi_password') as string)?.trim() || null,
      door_code:        (formData.get('door_code') as string)?.trim() || null,
      internal_notes:   (formData.get('internal_notes') as string)?.trim() || null,
      avg_nightly_rate: rate.value,
    },
  }
}

// ── Create ──────────────────────────────────────────

export async function createProperty(
  _prev: PropertyActionState | null,
  formData: FormData
): Promise<PropertyActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const parsed = parsePropertyForm(formData)
    if ('error' in parsed) return { error: parsed.error }
    const {
      name, address, city, state, zip, property_type, bedrooms, bathrooms,
      max_guests, checkin_time, checkout_time, wifi_name, wifi_password,
      door_code, internal_notes, avg_nightly_rate,
    } = parsed.fields

    // Plan property limit — UX only. The real enforcement is the
    // enforce_property_plan_limit trigger (migration 20260730600000), which
    // takes a FOR UPDATE lock on the org row so two concurrent creations at
    // the limit can't both pass. This check just gives a friendlier message
    // before the round trip.
    //
    // It fails CLOSED: `count ?? 0` used to coerce a FAILED count to zero,
    // which disabled the plan limit entirely for that request.
    const { count, error: countError } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', membership.org_id)
      .eq('is_active', true)

    if (reportQueryError(countError, {
      site: 'serverAction.properties.createProperty.limitCount',
      orgId: membership.org_id,
    })) {
      return { error: 'We could not verify your plan limit. Please try again.' }
    }

    if ((count ?? 0) >= membership.org.max_properties) {
      return {
        error: `Your plan allows up to ${membership.org.max_properties} properties. Upgrade to add more.`,
      }
    }

    const { data: property, error } = await supabase
      .from('properties')
      .insert({
        org_id:         membership.org_id,
        name,
        address:        address || null,
        city:           city || null,
        state:          state || null,
        zip:            zip || null,
        property_type,
        bedrooms,
        bathrooms,
        max_guests,
        checkin_time,
        checkout_time,
        wifi_name,
        wifi_password,
        internal_notes,
        avg_nightly_rate,
        setup_steps_completed: { details: true },
      })
      .select('id')
      .single()

    if (error) {
      console.error('[createProperty]', error)
      reportError(error, { site: 'serverAction.properties.createProperty.insert', orgId: membership.org_id })
      // 23514 is the check_violation the plan-limit trigger raises — the
      // enforcement path the count above only approximates.
      if (error.code === '23514' && error.message.includes('Property limit reached')) {
        return {
          error: `Your plan allows up to ${membership.org.max_properties} properties. Upgrade to add more.`,
        }
      }
      return { error: 'Operation failed. Please try again.' }
    }

    // The property row is already committed, so a Vault failure here must not
    // roll the whole create back into an error the PM would retry (creating a
    // duplicate). reportDoorCodeWrite() logs and reports without throwing —
    // the door code can be re-saved from the property edit form.
    if (door_code) {
      await reportDoorCodeWrite(supabase, property.id, membership.org_id, door_code, 'createProperty')
    }

    if (zip) {
      const coords = await geocodeZip(zip)
      if (coords) {
        await writeCoords(supabase, property.id, coords, 'createProperty')
      } else {
        console.warn('[createProperty] geocodeZip returned null for zip:', zip)
      }
    }

    // Non-fatal for exactly the reason the door-code and geocode writes above
    // are: the property row is already committed, and applyMasterChecklistToProperty
    // DOES throw (apply-master-template.ts:317). An unguarded throw here skipped
    // the audit log and the redirect, and surfaced as "Operation failed" for a
    // property that exists — so the PM retries and creates a duplicate. The
    // checklist can be re-applied from the property's checklist tab.
    try {
      await applyMasterChecklistToProperty(property.id, membership.org_id, supabase, {
        force:   false,
        actorId: user.id,
      })
    } catch (checklistErr) {
      console.error('[createProperty] master checklist apply failed', checklistErr)
      reportError(checklistErr, {
        site:  'serverAction.properties.createProperty.checklist',
        orgId: membership.org_id,
      })
    }

    // Same non-fatal treatment, and for the same reason: the property row is
    // already committed, so an unguarded throw would skip the audit log and the
    // redirect and surface as "Operation failed" for a property that exists —
    // the PM retries and creates a duplicate. Inventory can be re-applied from
    // Templates → Inventory → Par Levels.
    try {
      await applyStandardInventoryToProperty(property.id, membership.org_id, supabase)
    } catch (inventoryErr) {
      console.error('[createProperty] standard inventory apply failed', inventoryErr)
      reportError(inventoryErr, {
        site:  'serverAction.properties.createProperty.inventory',
        orgId: membership.org_id,
      })
    }

    // The items above carry the TEMPLATE's default par — a number computed for
    // a generic reference property. This resolves them against THIS property's
    // bedrooms/bathrooms/max_guests. Off the request path deliberately: it is
    // a whole-property recompute, and a new property showing generic pars for a
    // few seconds is not worth making the PM wait.
    await fireParRecompute(membership.org_id, property.id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.created',
      targetType: 'property',
      targetId:   property.id,
      metadata:   { name },
    })

    revalidatePath('/properties')
    redirect(`/properties/${property.id}/setup/details`)
  } catch (err) {
    // redirect() throws internally — let that propagate so navigation
    // actually happens; only genuine failures fall through below.
    unstable_rethrow(err)
    console.error('[createProperty]', err)
    reportError(err, { site: 'serverAction.properties.createProperty' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Update ───────────────────────────────────────────────────
//
// `updateProperty` lived here and was DELETED (2026-08-05): it had zero
// callers — its only two references in the repo were comments in
// lib/http/timeout.ts and lib/geocoding.ts — and the live property edit path
// is saveDetails() in ./[id]/setup/details/actions.ts.
//
// It was not merely a stale copy, it was a DIVERGENT one, which is why it was
// removed rather than left. It called store_property_door_code
// unconditionally, and that function's NULL branch DELETES the Vault secret.
// The edit form renders the door code masked until explicitly revealed, so
// saveDetails guards the write behind a `door_code_unchanged` hidden field;
// updateProperty never learned that, so wiring any form to it would have
// destroyed a property's door code on a rename. It also never wrote
// avg_nightly_rate, which createProperty sets — making that field write-once.

// ── Door code reveal ───────────────────────────────────────────

/**
 * Decrypts and returns a property's door code on demand for the read-only
 * property detail view, which otherwise renders it masked. Audit-logs every
 * reveal so there's a record of who viewed a physical-access credential
 * and when.
 */
export async function revealPropertyDoorCode(
  propertyId: string
): Promise<{ doorCode: string | null } | { error: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const { data: property, error: lookupError } = await supabase
      .from('properties')
      .select('id, door_code_secret_id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (lookupError) {
      console.error('[revealPropertyDoorCode] lookup failed', lookupError)
      reportError(lookupError, {
        site:  'serverAction.properties.revealPropertyDoorCode.lookup',
        orgId: membership.org_id,
      })
      return { error: 'Operation failed. Please try again.' }
    }

    if (!property) return { error: 'Property not found' }
    if (!property.door_code_secret_id) return { doorCode: null }

    const { data: doorCode, error } = await supabase.rpc('read_property_door_code', {
      p_property_id: propertyId,
      p_org_id:      membership.org_id,
    })

    if (error) {
      console.error('[revealPropertyDoorCode]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.door_code.viewed',
      targetType: 'property',
      targetId:   propertyId,
    })

    return { doorCode: (doorCode as string | null) ?? null }
  } catch (err) {
    console.error('[revealPropertyDoorCode]', err)
    reportError(err, { site: 'serverAction.properties.revealPropertyDoorCode' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Mark step complete ────────────────────────────────────────

export async function markStepComplete(
  propertyId: string,
  step: string
): Promise<void> {
  try {
    // Deliberately requireOrgMember, not requireOrgRole: this is a helper the
    // per-step setup actions call AFTER their own gated write succeeds, and it
    // is imported by five of them. The authorization that matters is the
    // properties UPDATE below, which now fails closed on the 0-row case rather
    // than silently marking a step complete for a caller RLS denied.
    const { supabase, membership } = await requireOrgMember()

    // ONE atomic statement. This was a read, a JS spread, and a write-back —
    // a read-modify-write with no precondition, which lost concurrent step
    // completions (two tabs, a double-submit, or two of the five caller
    // actions overlapping: both read the same object, both merged their own
    // key, the second write erased the first). It also collapsed a FAILED read
    // to `{}` and then overwrote the whole column with a single key, erasing
    // every previously completed step on a save that reported success.
    //
    // mark_property_setup_step merges with jsonb `||` inside the UPDATE, so
    // Postgres serialises the writers and there is no read to fail. It is
    // SECURITY INVOKER, so properties' RLS write policy still applies and a
    // denied write returns no row — which is what the null check below reads.
    const { data: mergedSteps, error: stepError } = await supabase.rpc('mark_property_setup_step', {
      p_property_id: propertyId,
      p_org_id:      membership.org_id,
      p_step:        step,
    })

    if (stepError) {
      console.error('[markStepComplete]', stepError)
      reportError(stepError, { site: 'serverAction.properties.markStepComplete.update', orgId: membership.org_id })
      throw new Error('Failed to record setup progress. Please try again.')
    }

    // 0 rows, no error: RLS denied it. Callers (the setup step actions) already
    // treat a throw as a failed save, so this surfaces instead of leaving the
    // step marked complete in the UI while nothing was written.
    if (!mergedSteps) throw new Error(NOTHING_UPDATED)

    // Read off the value the UPDATE actually wrote, not a second query that
    // could disagree with it.
    const updated = mergedSteps as Record<string, boolean>
    const allSteps = ['details', 'ical', 'inventory', 'messages', 'checklist', 'maintenance', 'crew']
    const isFullySetup = allSteps.every((s) => updated[s] === true)

    if (isFullySetup) {
      const propsRes = await supabase
        .from('properties')
        .select('id, setup_steps_completed')
        .eq('org_id', membership.org_id)
        .eq('is_active', true)
        .limit(500)
      const props = unwrapList(propsRes, { site: 'serverAction.properties.markStepComplete.propsRead', orgId: membership.org_id })

      const fullyConfigured = (props ?? []).filter((p) => {
        const steps = p.setup_steps_completed as Record<string, boolean>
        return allSteps.every((s) => steps?.[s] === true)
      })

      // `>= 2`, not `=== 2`: the count comes from a non-atomic read, so two
      // properties completing setup close together (or a count that crosses 2
      // in one step) skipped the milestone permanently with no reconciliation
      // anywhere. The upsert below is already idempotent, so the loosened
      // comparison cannot double-fire.
      if (fullyConfigured.length >= 2) {
        // Non-fatal: the step the caller asked for (mark_property_setup_step
        // above) already committed. Throwing here would report this whole
        // action as failed to the caller over a purely cosmetic milestone
        // flag — and the recompute above makes it self-healing on the next
        // property that crosses the threshold, same reasoning as
        // turnover-events.ts's record-completion-milestones step.
        const milestoneRes = await supabase.from('org_milestones').upsert(
          { org_id: membership.org_id, milestone: 'second_property_configured' },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        reportQueryError(milestoneRes.error, { site: 'serverAction.properties.markStepComplete.milestone', orgId: membership.org_id })
      }
    }

    revalidatePath(`/properties/${propertyId}`)
  } catch (err) {
    console.error('[markStepComplete]', err)
    reportError(err, { site: 'serverAction.properties.markStepComplete' })
    throw err
  }
}

// ── Asset CRUD ───────────────────────────────────────────────

export type AssetActionState = { error?: string; success?: boolean }

// Fires a manual-lookup event whenever an asset is saved with both make
// and model set — the Inngest handler is idempotent (skips if a row
// already exists for this org/asset_type/make/model), so calling this on
// every save is safe, not just on the first one.
//
// Never throws: this is a non-critical side effect of a successful asset
// save. A dispatch failure here must not turn into a user-facing "Failed
// to save asset" error for a save that actually succeeded.
/**
 * Resolves this property's smart pars against its own bedrooms/bathrooms/
 * max_guests. Extracted rather than inlined for the same reason
 * fireManualLookup is: createProperty is already at the cognitive-complexity
 * ceiling, and this is a dispatch, not part of the creation logic.
 *
 * Non-fatal by design — the property row is committed by the time this runs,
 * so a failed dispatch must not skip the audit log and the redirect and
 * surface as "Operation failed" for a property that exists. A missed recompute
 * self-heals on the next details save or an org-wide run; a duplicate property
 * does not.
 */
async function fireParRecompute(orgId: string, propertyId: string): Promise<void> {
  try {
    const { inngest } = await import('@/lib/inngest/client')
    await inngest.send({
      name: 'inventory/par-recompute-requested',
      data: { org_id: orgId, property_id: propertyId },
    })
  } catch (err) {
    console.error('[fireParRecompute]', err)
    reportError(err, { site: 'serverAction.properties.createProperty.parRecompute', orgId })
  }
}

async function fireManualLookup(
  orgId:     string,
  assetType: AssetType,
  make:      string | null,
  model:     string | null
): Promise<void> {
  if (!make || !model) return
  try {
    const { inngest } = await import('@/lib/inngest/client')
    await inngest.send({
      name: 'asset/manual_lookup.requested',
      data: { org_id: orgId, asset_type: assetType, make, model },
    })
  } catch (err) {
    console.error('[fireManualLookup]', err)
    reportError(err, { site: 'serverAction.properties.fireManualLookup', orgId })
  }
}

/**
 * The three numeric asset fields, parsed and validated identically for create
 * and update — an edit reaches the same depreciation and health-score columns
 * as a create, so it needs the same guards.
 *
 * The lifespan case is why these are REJECTED rather than coerced:
 * `expected_lifespan_years ?? standardsMidpoint` could never recover from a bad
 * value, because parseInt('abc') is NaN and NaN is neither null nor undefined —
 * `??` hands it straight through and the asset-type-standards default, the
 * whole point of the fallback, is skipped. NaN then reached
 * calculateHealthScore() and JSON-serialized to null on the way to the DB, so
 * one stray character silently produced no lifespan, no health score, and no
 * default.
 */
function parseAssetNumericFields(formData: FormData):
  | { fields: { purchase_price: number | null; estimated_replacement_cost: number | null; expected_lifespan_years: number | null } }
  | { error: string } {
  const price = optionalMoneyField(formData.get('purchase_price'))
  if (!price.ok) return { error: `Purchase price: ${price.error}` }

  const replacement = optionalMoneyField(formData.get('estimated_replacement_cost'))
  if (!replacement.ok) return { error: `Replacement cost: ${replacement.error}` }

  const lifespan = optionalPositiveInt(formData.get('expected_lifespan_years'), MAX_LIFESPAN_YEARS)
  if (!lifespan.ok) {
    return { error: `Expected lifespan must be a whole number of years between 1 and ${MAX_LIFESPAN_YEARS}.` }
  }

  return {
    fields: {
      purchase_price:             price.value,
      estimated_replacement_cost: replacement.value,
      expected_lifespan_years:    lifespan.value,
    },
  }
}

/**
 * Confirms `propertyId` exists and belongs to `orgId`. Shared by createAsset
 * and replaceAsset — factored out so each stays under the cognitive-complexity
 * limit rather than repeating the same query-error/not-found branch twice.
 */
async function validateAssetProperty(
  supabase:   ActionSupabase,
  propertyId: string,
  orgId:      string,
  actionSite: string,
): Promise<{ error: string } | { ok: true }> {
  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .single()

  if (isRealQueryError(propertyError)) {
    console.error(`[${actionSite}] property read failed`, propertyError)
    reportError(propertyError, { site: `serverAction.properties.${actionSite}.property`, orgId })
    return { error: 'Failed to save asset' }
  }
  if (!property) return { error: 'Property not found' }

  return { ok: true }
}

/**
 * Loads asset_type_standards for `assetType` and derives the lifespan/health
 * score an insert or the replace RPC should carry. Shared by createAsset and
 * replaceAsset for the same reason as validateAssetProperty above — this is
 * the exact TypeScript computation replaceAsset's own comment already
 * describes as "kept in TypeScript rather than duplicated in the RPC" — it
 * was duplicated in THIS file instead, which is the piece this closes.
 */
async function resolveAssetStandardsAndHealth(
  supabase:                   ActionSupabase,
  assetType:                  AssetType,
  installationDate:           string | null,
  expectedLifespanYearsInput: number | null,
  estimatedReplacementCost:   number | null,
  orgId:                      string,
  actionSite:                 string,
): Promise<
  | { error: string }
  | { standards: Pick<AssetTypeStandard, 'lifespan_min_years' | 'lifespan_max_years' | 'avg_replacement_cost_high' | 'macrs_class_default' | 'weibull_shape'> | null
      lifespan: number | null
      health_score: number | null }
> {
  const { data: standards, error: standardsError } = await supabase
    .from('asset_type_standards')
    .select('lifespan_min_years, lifespan_max_years, avg_replacement_cost_high, macrs_class_default, weibull_shape')
    .eq('asset_type', assetType)
    .single()

  if (standardsError && standardsError.code !== 'PGRST116') {
    console.error(`[${actionSite}] asset_type_standards read failed`, standardsError)
    reportError(standardsError, { site: `serverAction.properties.${actionSite}.standards`, orgId })
    return { error: 'Could not load asset defaults. Please try again.' }
  }

  const lifespan = expectedLifespanYearsInput ?? (
    standards
      ? Math.round((standards.lifespan_min_years + standards.lifespan_max_years) / 2)
      : null
  )

  let health_score: number | null = null
  if (standards && installationDate) {
    health_score = calculateHealthScore(
      { installation_date: installationDate, expected_lifespan_years: lifespan, estimated_replacement_cost: estimatedReplacementCost },
      standards,
      { total_repairs: 0, total_repair_cost: 0, last_serviced_at: null },
    )
  }

  return { standards, lifespan, health_score }
}

export async function createAsset(
  propertyId: string,
  _prev: AssetActionState | null,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const name              = (formData.get('name') as string)?.trim()
    const asset_type_raw    = formData.get('asset_type') as string | null
    const make              = (formData.get('make') as string)?.trim() || null
    const model             = (formData.get('model') as string)?.trim() || null
    const serial_number     = (formData.get('serial_number') as string)?.trim() || null
    const installation_date = (formData.get('installation_date') as string) || null
    const warranty_expiry_date = (formData.get('warranty_expiry_date') as string) || null
    const warranty_provider    = (formData.get('warranty_provider') as string)?.trim() || null
    const notes                = (formData.get('notes') as string)?.trim() || null

    if (!name)           return { error: 'Asset name is required' }
    if (!asset_type_raw) return { error: 'Asset type is required' }

    const numbers = parseAssetNumericFields(formData)
    if ('error' in numbers) return { error: numbers.error }
    const { purchase_price, estimated_replacement_cost, expected_lifespan_years } = numbers.fields

    // property_assets.asset_type is an enum with no default, so there is no
    // safe value to fall back to — reject rather than coerce.
    if (!isDbEnum('asset_type', asset_type_raw)) {
      return { error: `Unrecognized asset type: ${asset_type_raw}` }
    }
    const asset_type: AssetType = asset_type_raw

    const propertyCheck = await validateAssetProperty(supabase, propertyId, membership.org_id, 'createAsset')
    if ('error' in propertyCheck) return { error: propertyCheck.error }

    // Error bound, not discarded: this read decides the asset's MACRS class,
    // its lifespan and its health score. Treating a failed read as "no
    // standards" wrote a DIFFERENT tax class (the '5_year' fallback) and no
    // health score, recorded as though those were the chosen values.
    const resolved = await resolveAssetStandardsAndHealth(
      supabase, asset_type, installation_date, expected_lifespan_years,
      estimated_replacement_cost, membership.org_id, 'createAsset',
    )
    if ('error' in resolved) return { error: resolved.error }
    const { standards, lifespan, health_score } = resolved

    const { data: asset, error } = await supabase
      .from('property_assets')
      .insert({
        property_id:               propertyId,
        org_id:                    membership.org_id,
        name,
        asset_type,
        make,
        model,
        serial_number,
        installation_date,
        placed_in_service_date:    installation_date,
        purchase_price,
        estimated_replacement_cost,
        expected_lifespan_years:   lifespan,
        warranty_expiry_date,
        warranty_provider,
        notes,
        health_score,
        health_score_updated_at:   health_score !== null ? new Date().toISOString() : null,
        macrs_class:               standards?.macrs_class_default ?? '5_year',
        depreciation_method:       'macrs',
        salvage_value:             0,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[createAsset]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.created',
      targetType: 'property_asset',
      targetId:   asset?.id,
      metadata:   { property_id: propertyId, asset_type },
    })

    await fireManualLookup(membership.org_id, asset_type, make, model)

    revalidatePath('/assets')
    return { success: true }
  } catch (err) {
    console.error('[createAsset]', err)
    reportError(err, { site: 'serverAction.properties.createAsset' })
    return { error: 'Failed to save asset' }
  }
}

/**
 * Replaces an asset: creates the new unit and marks the old one
 * is_active=false / replaced_by_asset_id / replaced_at, in one transaction
 * (replace_property_asset RPC — see its migration for why two separate
 * writes here was not acceptable). This is also the only place
 * property_assets.replaced_at is ever set — it's the ground truth a future
 * pass can fit a real per-asset-type Weibull shape against (see
 * asset-weibull-shape-fit.ts), so a partially-applied replace (new asset
 * created, old one never linked) would quietly corrupt that data forever.
 */
export async function replaceAsset(
  oldAssetId: string,
  propertyId: string,
  _prev: AssetActionState | null,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const name              = (formData.get('name') as string)?.trim()
    const asset_type_raw    = formData.get('asset_type') as string | null
    const make              = (formData.get('make') as string)?.trim() || null
    const model              = (formData.get('model') as string)?.trim() || null
    const serial_number     = (formData.get('serial_number') as string)?.trim() || null
    const installation_date = (formData.get('installation_date') as string) || null
    const warranty_expiry_date = (formData.get('warranty_expiry_date') as string) || null
    const warranty_provider    = (formData.get('warranty_provider') as string)?.trim() || null
    const notes                = (formData.get('notes') as string)?.trim() || null

    if (!name)           return { error: 'Asset name is required' }
    if (!asset_type_raw) return { error: 'Asset type is required' }

    const numbers = parseAssetNumericFields(formData)
    if ('error' in numbers) return { error: numbers.error }
    const { purchase_price, estimated_replacement_cost, expected_lifespan_years } = numbers.fields

    if (!isDbEnum('asset_type', asset_type_raw)) {
      return { error: `Unrecognized asset type: ${asset_type_raw}` }
    }
    const asset_type: AssetType = asset_type_raw

    const propertyCheck = await validateAssetProperty(supabase, propertyId, membership.org_id, 'replaceAsset')
    if ('error' in propertyCheck) return { error: propertyCheck.error }

    // Same standards read + health-score compute as createAsset — kept in
    // TypeScript rather than duplicated in the RPC's PL/pgSQL body.
    const resolved = await resolveAssetStandardsAndHealth(
      supabase, asset_type, installation_date, expected_lifespan_years,
      estimated_replacement_cost, membership.org_id, 'replaceAsset',
    )
    if ('error' in resolved) return { error: resolved.error }
    const { standards, lifespan, health_score } = resolved

    const { data: rpcData, error: rpcError } = await supabase.rpc('replace_property_asset', {
      p_org_id:       membership.org_id,
      p_old_asset_id: oldAssetId,
      p_new_asset: {
        property_id: propertyId,
        name, make, model, serial_number,
        asset_type,
        installation_date,
        purchase_price,
        estimated_replacement_cost,
        expected_lifespan_years: lifespan,
        warranty_expiry_date, warranty_provider, notes,
        health_score,
        macrs_class: standards?.macrs_class_default ?? '5_year',
      },
    })

    if (rpcError) {
      console.error('[replaceAsset]', rpcError)
      reportError(rpcError, { site: 'serverAction.properties.replaceAsset.rpc', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    const result = rpcData as { ok: boolean; reason?: string; new_asset_id?: string }
    if (!result.ok) {
      return {
        error: result.reason === 'already_replaced_or_inactive'
          ? 'This asset has already been replaced or deactivated.'
          : 'Asset not found.',
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.replaced',
      targetType: 'property_asset',
      targetId:   oldAssetId,
      metadata:   { new_asset_id: result.new_asset_id, property_id: propertyId, asset_type },
    })

    await fireManualLookup(membership.org_id, asset_type, make, model)

    revalidatePath('/assets')
    return { success: true }
  } catch (err) {
    console.error('[replaceAsset]', err)
    reportError(err, { site: 'serverAction.properties.replaceAsset' })
    return { error: 'Failed to save asset' }
  }
}

export async function updateAsset(
  assetId: string,
  propertyId: string,
  _prev: AssetActionState | null,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const name              = (formData.get('name') as string)?.trim()
    const make              = (formData.get('make') as string)?.trim() || null
    const model             = (formData.get('model') as string)?.trim() || null
    const serial_number     = (formData.get('serial_number') as string)?.trim() || null
    const installation_date = (formData.get('installation_date') as string) || null
    const warranty_expiry_date = (formData.get('warranty_expiry_date') as string) || null
    const warranty_provider    = (formData.get('warranty_provider') as string)?.trim() || null
    const notes                = (formData.get('notes') as string)?.trim() || null

    if (!name) return { error: 'Asset name is required' }

    const numbers = parseAssetNumericFields(formData)
    if ('error' in numbers) return { error: numbers.error }
    const { purchase_price, estimated_replacement_cost, expected_lifespan_years } = numbers.fields

    const { data: updated, error } = await supabase
      .from('property_assets')
      .update({
        name, make, model, serial_number,
        installation_date, placed_in_service_date: installation_date,
        purchase_price, estimated_replacement_cost,
        expected_lifespan_years, warranty_expiry_date, warranty_provider, notes,
      })
      .eq('id', assetId)
      .eq('org_id', membership.org_id)
      .select('asset_type')
      .maybeSingle()

    if (error) {
      console.error('[updateAsset]', error)
      reportError(error, { site: 'serverAction.properties.updateAsset.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // 0 rows with no error = RLS denied the write (or the asset is gone).
    if (!updated) {
      console.warn('[updateAsset] update matched 0 rows', { assetId })
      return { error: NOTHING_UPDATED }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.updated',
      targetType: 'property_asset',
      targetId:   assetId,
      metadata:   { property_id: propertyId },
    })

    await fireManualLookup(membership.org_id, updated.asset_type, make, model)

    revalidatePath('/assets')
    return { success: true }
  } catch (err) {
    console.error('[updateAsset]', err)
    reportError(err, { site: 'serverAction.properties.updateAsset' })
    return { error: 'Failed to update asset' }
  }
}

export async function deactivateAsset(assetId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(PROPERTY_WRITE_ROLES)
    const { data: deactivated, error } = await supabase
      .from('property_assets')
      .update({ is_active: false })
      .eq('id', assetId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deactivateAsset]', error)
      reportError(error, { site: 'serverAction.properties.deactivateAsset.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // 0 rows with no error = RLS denied the write (or the asset is gone).
    if (!deactivated) {
      console.warn('[deactivateAsset] update matched 0 rows', { assetId })
      return { error: NOTHING_UPDATED }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.deactivated',
      targetType: 'property_asset',
      targetId:   assetId,
    })

    revalidatePath('/assets')
    return {}
  } catch (err) {
    console.error('[deactivateAsset]', err)
    reportError(err, { site: 'serverAction.properties.deactivateAsset' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Bulk CSV asset import ─────────────────────────────────────

export interface CsvAssetRow {
  name:                      string
  asset_type:                string
  make:                      string | null
  model:                     string | null
  serial_number:             string | null
  installation_date:         string | null
  purchase_price:            number | null
  estimated_replacement_cost: number | null
  warranty_expiry_date:      string | null
  warranty_provider:         string | null
  notes:                     string | null
}

export async function bulkImportAssets(
  propertyId: string,
  rows:       CsvAssetRow[],
): Promise<{ imported: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const { data: property, error: propertyError } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (isRealQueryError(propertyError)) {
      console.error('[bulkImportAssets] property read failed', propertyError)
      reportError(propertyError, { site: 'serverAction.properties.bulkImportAssets.property', orgId: membership.org_id })
      return { imported: 0, error: 'Import failed — please try again' }
    }
    if (!property) return { imported: 0, error: 'Property not found' }

    // `rows` arrives from the client with no bound of its own, and every row
    // goes into ONE .insert(). The action already re-validates asset_type
    // server-side because "this action takes the parsed rows on trust" — size
    // is the same trust, and an unbounded array is a single enormous statement
    // against a 90-connection Postgres.
    if (rows.length > MAX_IMPORT_ROWS) {
      return {
        imported: 0,
        error: `Import is limited to ${MAX_IMPORT_ROWS} rows at a time. Split the file and re-upload.`,
      }
    }

    // Per-row numbers are typed `number | null` but nothing enforces that at
    // runtime. NaN and ±Infinity JSON-serialize to null (a silently dropped
    // price), and a negative purchase_price reaches MACRS depreciation.
    const badNumberRow = rows.findIndex((r) =>
      [r.purchase_price, r.estimated_replacement_cost].some(
        (v) => v !== null && v !== undefined && !(Number.isFinite(v) && v >= 0),
      ),
    )
    if (badNumberRow !== -1) {
      return {
        imported: 0,
        error: `Row ${badNumberRow + 1} has an invalid price. Prices must be a number of 0 or more.`,
      }
    }

    // asset_type arrives from an uploaded CSV. The parser flags unresolvable
    // types, but that runs client-side and this action takes the parsed rows
    // on trust, so re-check here — the column is an enum and this is a BULK
    // insert, meaning one unrecognized value makes Postgres reject every row
    // (22P02) behind a generic "Operation failed" with nothing naming the
    // offending type.
    const validRows = rows.filter(
      (r): r is CsvAssetRow & { asset_type: AssetType } => isDbEnum('asset_type', r.asset_type)
    )
    if (validRows.length !== rows.length) {
      const badTypes = [...new Set(
        rows.filter((r) => !isDbEnum('asset_type', r.asset_type)).map((r) => r.asset_type)
      )]
      return {
        imported: 0,
        error: `Unrecognized asset type(s): ${badTypes.join(', ')}. Fix these rows and re-upload.`,
      }
    }

    // Platform catalog (21 rows today). fetchAllRows costs exactly one request
    // at this size and cannot silently truncate if the catalog ever grows.
    // Nullability matches the live schema: all three are NOT NULL on
    // asset_type_standards (lifespan_min_years / lifespan_max_years smallint
    // NOT NULL, macrs_class_default NOT NULL DEFAULT '5_year').
    const standards = await fetchAllRows<{
      asset_type:          AssetType
      macrs_class_default: Enums<'macrs_class'>
      lifespan_min_years:  number
      lifespan_max_years:  number
    }>(
      (from, to) => supabase
        .from('asset_type_standards')
        .select('asset_type, macrs_class_default, lifespan_min_years, lifespan_max_years')
        .order('asset_type')
        .range(from, to),
      { label: 'properties.actions.assetTypeStandards' },
    )

    const stdMap = Object.fromEntries(standards.map((s) => [s.asset_type, s]))

    const insertRows: TablesInsert<'property_assets'>[] = validRows.map((row) => {
      const std = stdMap[row.asset_type]
      return {
        org_id:                     membership.org_id,
        property_id:                propertyId,
        name:                       row.name,
        asset_type:                 row.asset_type,
        make:                       row.make,
        model:                      row.model,
        serial_number:              row.serial_number,
        installation_date:          row.installation_date,
        placed_in_service_date:     row.installation_date,
        purchase_price:             row.purchase_price,
        estimated_replacement_cost: row.estimated_replacement_cost,
        warranty_expiry_date:       row.warranty_expiry_date,
        warranty_provider:          row.warranty_provider,
        notes:                      row.notes,
        macrs_class:                std?.macrs_class_default ?? '5_year',
        expected_lifespan_years:    std
          ? Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2)
          : null,
        depreciation_method:       'macrs',
        salvage_value:             0,
        is_active:                 true,
        setup_steps_completed:     {},
      }
    })

    const { error } = await supabase.from('property_assets').insert(insertRows)
    if (error) {
      console.error('[bulkImportAssets]', error)
      return { imported: 0, error: 'Import failed — please try again' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.bulk_imported',
      targetType: 'property_asset',
      targetId:   propertyId,
      metadata:   { count: rows.length, property_id: propertyId },
    })

    // Non-critical side effect of a successful import — a dispatch failure
    // here must not turn `rows.length` genuinely-imported assets into a
    // user-facing "Import failed" result.
    try {
      const { inngest } = await import('@/lib/inngest/client')
      const lookupEvents = insertRows
        .filter((r) => r.make && r.model)
        .map((r) => ({
          name: 'asset/manual_lookup.requested' as const,
          data: { org_id: r.org_id, asset_type: r.asset_type, make: r.make!, model: r.model! },
        }))
      if (lookupEvents.length > 0) await inngest.send(lookupEvents)
    } catch (err) {
      console.error('[bulkImportAssets] manual lookup dispatch failed', err)
      reportError(err, { site: 'serverAction.properties.bulkImportAssets.inner', orgId: membership.org_id })
    }

    revalidatePath('/assets')
    return { imported: rows.length }
  } catch (err) {
    console.error('[bulkImportAssets]', err)
    reportError(err, { site: 'serverAction.properties.bulkImportAssets' })
    return { imported: 0, error: 'Import failed — please try again' }
  }
}

// ── Archive ──────────────────────────────────────────────────

export async function archiveProperty(propertyId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const { data: archived, error } = await supabase
      .from('properties')
      .update({ is_active: false })
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[archiveProperty]', error)
      reportError(error, { site: 'serverAction.properties.archiveProperty.update', orgId: membership.org_id })
      throw new Error('Failed to archive property. Please try again.')
    }

    // 0 rows with no error = RLS denied it. Without this the action redirected
    // to /properties as if the archive had happened.
    if (!archived) {
      console.warn('[archiveProperty] update matched 0 rows', { propertyId })
      throw new Error(NOTHING_UPDATED)
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.archived',
      targetType: 'property',
      targetId:   propertyId,
    })

    revalidatePath('/properties')
    redirect('/properties')
  } catch (err) {
    // redirect() throws internally — let that propagate so navigation
    // actually happens; only genuine failures fall through below. The
    // caller (details-form.tsx) surfaces e.message directly to the PM,
    // so throw a generic message rather than the raw error.
    unstable_rethrow(err)
    console.error('[archiveProperty]', err)
    reportError(err, { site: 'serverAction.properties.archiveProperty' })
    throw new Error('Failed to archive property. Please try again.')
  }
}
