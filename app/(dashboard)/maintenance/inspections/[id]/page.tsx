import type { Metadata } from 'next'

import { requireOrgMember } from '@/lib/auth'

import { FillScreen } from './fill-screen'

export const metadata: Metadata = { title: 'Inspection' }

/**
 * The fill screen's route — a SHELL, deliberately holding no data.
 *
 * Every other page in the dashboard renders its data on the server. This one
 * must not, and public/sw.js states the reason as the condition for
 * /maintenance ever joining the offline allowlist:
 *
 *   "What this worker caches is the SERVER-RENDERED HTML of a page. […] serving
 *    it from cache serves last Tuesday's board no matter how current the
 *    IndexedDB copy beside it is. […] /maintenance goes in when it renders from
 *    the local cache, not when the local cache exists."
 *
 * So this component resolves three ids and stops. The HTML the service worker
 * caches is then a frame with no facts in it, which cannot go stale, and
 * everything with a value comes from Dexie.
 *
 * `requireOrgMember()` still runs here rather than being skipped as "the client
 * will check anyway" — it is what establishes the org whose cache is opened,
 * and a client-supplied org id would be the whole tenant boundary handed to the
 * browser.
 */
export default async function InspectionFillPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params
  const { user, membership } = await requireOrgMember()

  return <FillScreen inspectionId={id} userId={user.id} orgId={membership.org_id} />
}
