import type { Metadata } from 'next'

import { requireOrgMember } from '@/lib/auth'

import { InspectionsView } from './inspections-view'

export const metadata: Metadata = { title: 'Inspections' }

/**
 * The inspections list — a SHELL, holding no data, for the same reason the fill
 * screen is one.
 *
 * This was a Server Component that fetched properties and inspections. It could
 * not stay one once a walk became startable offline (20260823053931): if you
 * can start an inspection with no signal you have to be able to SEE it, and per
 * public/sw.js a route only joins the offline allowlist when it renders from
 * the local cache. A cached server-rendered roster is last Tuesday's.
 *
 * So this resolves three ids and stops. `requireOrgMember()` still runs — it is
 * what establishes the org whose cache is opened, and a client-supplied org id
 * would hand the tenant boundary to the browser.
 */
export default async function InspectionsPage() {
  const { user, membership } = await requireOrgMember()

  return <InspectionsView userId={user.id} orgId={membership.org_id} />
}
