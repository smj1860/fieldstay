// lib/integrations/providers/ownerrez-cleaning-probe.ts
// ============================================================================
// Persists what we observe about OwnerRez's `cleaning_date`, so the decision to
// use it (or not) is made against production data.
//
// WHY A STORED PROBE RATHER THAN A LOG LINE
//
// The question is a RATE over time — "is this field ever populated, and does it
// ever carry information checkout_date does not" — and the incremental sync
// sees a different handful of changed bookings every hour. A log line answers
// it only if someone aggregates a week of them; a row answers it with one
// query. It is also the difference between noticing a field is always null and
// concluding it, which is the distinction that keeps costing this codebase.
//
// ACCUMULATES, never overwrites. A snapshot of the last batch would read
// "0 of 0" on any hour with no changed bookings — indistinguishable from
// "0 of 400, never populated", and the wrong one of those cancels the feature.
//
// NON-FATAL BY CONSTRUCTION. This is diagnostics attached to the path that
// imports a PM's bookings; it must never be able to fail that path. Every
// caller wraps it, and it swallows its own errors besides.
// ============================================================================

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { OwnerRezCleaningDateProbe } from '@/lib/integrations/providers/ownerrez'

/** One row per org, upsert keyed on the table's UNIQUE (org_id, milestone). */
export const CLEANING_PROBE_MILESTONE = 'probe:ownerrez_cleaning_date'

interface StoredProbe extends OwnerRezCleaningDateProbe {
  /** Batches folded in, so a rate can be read against how often we looked. */
  batches:      number
  last_seen_at: string
}

function foldProbe(prev: Partial<StoredProbe> | null, next: OwnerRezCleaningDateProbe, nowIso: string): StoredProbe {
  return {
    total:               (prev?.total               ?? 0) + next.total,
    withCleaningDate:    (prev?.withCleaningDate    ?? 0) + next.withCleaningDate,
    derivedFromCheckout: (prev?.derivedFromCheckout ?? 0) + next.derivedFromCheckout,
    withTimeOfDay:       (prev?.withTimeOfDay       ?? 0) + next.withTimeOfDay,
    batches:             (prev?.batches             ?? 0) + 1,
    last_seen_at:        nowIso,
  }
}

/**
 * Fold one batch's observation into the org's running probe row.
 *
 * Read-modify-write, which is racy in principle and adequate here on purpose:
 * the syncs that call it are serialized per connection, and the question being
 * answered ("is this ever non-zero, and is it ever more than the checkout
 * date") survives a lost increment intact. A stricter accumulator would mean a
 * migration and an RPC for a measurement we intend to delete.
 */
export async function recordCleaningDateProbe(
  supabase: SupabaseClient,
  orgId:    string,
  observed: OwnerRezCleaningDateProbe,
  nowIso:   string,
): Promise<void> {
  // Nothing examined, nothing to say — and folding it would inflate `batches`
  // with hours that could not have observed anything.
  if (observed.total === 0) return

  try {
    const existingRes = await supabase
      .from('org_milestones')
      .select('value')
      .eq('org_id', orgId)
      .eq('milestone', CLEANING_PROBE_MILESTONE)
      .maybeSingle()

    // Read failure ABANDONS the fold rather than treating it as "no prior
    // value". Folding onto null would write this batch's counts over an
    // accumulator holding weeks of them — turning a transient read error into
    // permanent data loss, in the one direction that matters here: a probe
    // silently reset to near-zero reads as "the field is never populated",
    // which is the conclusion that cancels the feature.
    //
    // Losing one batch is fine. Losing the history is not.
    if (existingRes.error) return

    const merged = foldProbe((existingRes.data?.value ?? null) as Partial<StoredProbe> | null, observed, nowIso)

    await supabase
      .from('org_milestones')
      .upsert(
        { org_id: orgId, milestone: CLEANING_PROBE_MILESTONE, value: merged },
        { onConflict: 'org_id,milestone' },
      )
  } catch {
    // Deliberately silent. A diagnostic that can page someone, or worse fail a
    // booking import, costs more than the measurement is worth.
  }
}
