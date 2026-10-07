import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowLeft } from 'lucide-react'
import { requireOrgMember } from '@/lib/auth'
import { unwrapList } from '@/lib/supabase/unwrap'
import { ArchivedList, type ArchivedProperty } from './archived-list'

// ============================================================================
// /properties/archived — put an archived property back into service.
//
// ── Why its own page, and not Settings or a filter on /properties ─────────
//
// Settings is org configuration (billing, team, integrations, retention); a
// single property coming back from the dead is a RECORD, not a setting, and
// nobody hunting for a property they archived goes looking under Settings.
//
// A "show archived" toggle on /properties was the other candidate and is
// worse. That page's query is a Promise.all of the property list plus three
// paginated ops-badge reads (open work orders, unassigned turnovers, errored
// feeds) that it counts per property. An archived property has none of that by
// definition, so a toggle would either run those three drains for rows that
// cannot have results, or branch the whole query on a flag. A separate page
// asks for five columns and stops.
//
// ── What this page deliberately does NOT do ──────────────────────────────
//
// No work-order counts, no setup progress, no ops badges. The only question
// here is "which ones did I archive, and can I have one back".
//
// The plan ceiling is enforced in the DATABASE, by the
// enforce_property_plan_limit trigger, which fires on UPDATE OF is_active and
// treats a false->true flip as a new claim on capacity. So this page does not
// pre-check capacity and then offer a button that lies: it offers the button,
// and unarchiveProperty turns the trigger's 23514 into the real reason.
// ============================================================================

export const metadata: Metadata = { title: 'Archived Properties' }

export default async function ArchivedPropertiesPage() {
  const { supabase, membership } = await requireOrgMember()

  // Bounded by the plan ceiling in spirit but not in fact: archived rows do
  // not consume capacity, so this set grows with TIME rather than with the
  // 150-property ceiling. An explicit limit keeps it off PostgREST's silent
  // max_rows truncation, and 500 is far past any realistic archive.
  const properties = unwrapList<ArchivedProperty>(
    await supabase
      .from('properties')
      .select('id, name, address, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', false)
      .order('name')
      .limit(500),
    { site: 'page.properties.archived', orgId: membership.org_id },
  )

  return (
    <div className="max-w-3xl">
      <Link
        href="/properties"
        className="inline-flex items-center gap-1.5 text-sm mb-4 hover:underline"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Back to properties
      </Link>

      <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        Archived properties
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
        These are off your active list and out of automated jobs, and they do not count
        toward your bill. Restore one and it goes back to both.
      </p>

      <ArchivedList properties={properties} />
    </div>
  )
}
