import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { firstSafetyDueDate, readSafetyTemplate, type SafetyTemplate } from './safety-template'

// Turning the org's safety template into one schedule per property.
//
// TWO CALLERS, ONE FUNCTION, AND THAT IS THE POINT. The onboarding step applies
// it to every property the org has today; a nightly pass applies it to every
// property added since. Written twice they would drift, and the drift would be
// invisible — a property quietly missing the walk it was supposed to get, which
// is the same silent-gap shape as a schedule that never advances.
//
// WHY A NIGHTLY PASS RATHER THAN A HOOK ON PROPERTY CREATION. Properties are
// created from five places — the manual form plus four PMS importers — and the
// next importer would make six. One pass over the org catches every path,
// including ones that do not exist yet, and costs at most a day's delay on a
// walk that runs once or twice a year.
//
// IDEMPOTENT BY CONSTRUCTION, not by being careful:
// `uq_maintenance_schedules_property_inspection_form` (20260824091200) is a
// partial unique index on (property_id, inspection_form_id) WHERE
// creates = 'inspection', so the insert can collide instead of the caller
// having to check first. That matters because "read what exists, then write
// what doesn't" is the exact load-then-decide-then-write shape that races when
// onboarding and the cron overlap.

/** Bound on one org's fan-out. Well above the 50-property plan ceiling. */
const MAX_PROPERTIES = 500

export interface ApplyResult {
  /** Schedules actually inserted. Zero is the steady state after the first run. */
  created: number
  /** Properties considered — the denominator, for the log line. */
  properties: number
  skipped?: 'no_template' | 'no_form' | 'no_properties'
}

/**
 * Creates the safety schedule for every property in `orgId` that lacks one.
 *
 * Never throws for an ordinary miss — a missing template or an unseeded form
 * library is a reason to do nothing, not to fail the caller. A genuine query
 * error DOES throw, because "we could not read the properties" must not be
 * indistinguishable from "this org has none": the second is a legitimate steady
 * state and the first would silently skip an entire org, forever, on every run.
 */
export async function applySafetyTemplate(
  supabase: SupabaseClient,
  orgId:    string,
  opts:     { template?: SafetyTemplate | null; today?: Date } = {},
): Promise<ApplyResult> {
  const template = opts.template ?? (await loadTemplate(supabase, orgId))
  if (!template) return { created: 0, properties: 0, skipped: 'no_template' }

  const formId = await loadSafetyFormId(supabase)
  if (!formId) return { created: 0, properties: 0, skipped: 'no_form' }

  // ACTIVE only. An archived property is one the PM has stopped managing, and
  // scheduling a safety walk on it would put a due notification on the board
  // for a house nobody is going to. Matches the same filter the cron's own org
  // fan-out uses to decide which orgs to dispatch at all.
  const { data: properties, error } = await supabase
    .from('properties')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .limit(MAX_PROPERTIES)

  if (error) throw new Error(`property load failed for org ${orgId}: ${error.message}`)
  if (!properties?.length) return { created: 0, properties: 0, skipped: 'no_properties' }

  const dueDate = firstSafetyDueDate(template, opts.today ?? new Date())

  const rows = properties.map((p) => ({
    org_id:              orgId,
    property_id:         p.id,
    name:                SAFETY_SCHEDULE_NAME,
    schedule_type:       'routine' as const,
    frequency:           template.frequency,
    next_due_date:       dueDate,
    creates:             'inspection' as const,
    inspection_form_id:  formId,
    // Left unassigned on purpose. §2 leaves "who performs one" to the PM, and
    // guessing an assignee at onboarding would send a due notification to
    // somebody who never agreed to walk 29 properties.
    assigned_to_user_id: null,
    // Inspections notify; they never auto-create a work order (§7).
    auto_create_wo:      false,
    is_active:           true,
  }))

  // ON CONFLICT DO NOTHING against the partial unique index. A property that
  // already has a safety schedule keeps the one it has — including its
  // next_due_date, which may have advanced past this template's first
  // occurrence and must not be dragged back.
  const { data: inserted, error: insertError } = await supabase
    .from('maintenance_schedules')
    .upsert(rows, {
      onConflict:       'property_id,inspection_form_id',
      ignoreDuplicates: true,
    })
    .select('id')

  if (insertError) {
    throw new Error(`safety schedule fan-out failed for org ${orgId}: ${insertError.message}`)
  }

  return { created: inserted?.length ?? 0, properties: properties.length }
}

/**
 * The name every generated safety schedule carries.
 *
 * A constant rather than a per-property string: it is what a PM scans the
 * Maintenance list for, and it is how "did the template already run here?"
 * reads at a glance. The unique index, not this name, is what enforces
 * uniqueness.
 */
export const SAFETY_SCHEDULE_NAME = 'Safety & Risk Mitigation Inspection'

async function loadTemplate(
  supabase: SupabaseClient,
  orgId:    string,
): Promise<SafetyTemplate | null> {
  const { data, error } = await supabase
    .from('organizations')
    .select('inspection_safety_frequency, inspection_safety_start_month')
    .eq('id', orgId)
    .maybeSingle()

  if (error) throw new Error(`safety template load failed for org ${orgId}: ${error.message}`)
  if (!data) return null
  return readSafetyTemplate(data)
}

/**
 * The platform's safety form id.
 *
 * Highest active version, matching what the device picks when a walk starts —
 * the schedule must point at the form a PM will actually be handed. Returns
 * null rather than throwing when the seed has not run: an org onboarding
 * against an unseeded database should be told nothing was scheduled, not handed
 * a 500.
 */
async function loadSafetyFormId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from('inspection_forms')
    .select('id, version')
    .eq('key', 'safety')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)

  if (error) throw new Error(`safety form lookup failed: ${error.message}`)
  return data?.[0]?.id ?? null
}
