import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { VendorPortal } from '../../[token]/vendor-portal'
import { loadPortalPage } from '../../[token]/load-portal'
import { IdentifyGate } from './identify-gate'
import { ExpiredPortal } from '../../[token]/expired-portal'

export const metadata: Metadata = {
  title: 'Work Order | FieldStay',
  // A forwarded link is pasted into texts and group chats, where a preview
  // would show a property and a job to anyone in the thread.
  robots: { index: false, follow: false },
}

/**
 * A TECHNICIAN's forwarded work order.
 *
 * Shares `loadPortalPage` with the vendor's own page, so the two are not the
 * same screen built from two query shapes. The differences are both enforced
 * below the token: `principalKind` hides the send-to-technician panel (a
 * forwarded link must not mint further ones), and `resolvePortalToken` refuses
 * a grant that was revoked, expired, or belongs to a vendor the work order has
 * since moved away from.
 *
 * The identify gate comes FIRST. `work_orders` carries lockbox_code,
 * access_notes and parking_notes, so a link pasted into the wrong thread must
 * not hand a stranger a door code before anybody has said who they are.
 */
export default async function TechnicianWorkOrderPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const load = await loadPortalPage(token)
  if (load.kind === 'not_found') notFound()

  // A revoked grant resolves as expired, deliberately: the holder cannot tell
  // the difference and does not need to, and naming revocation would tell
  // whoever holds a leaked link that somebody noticed.
  if (load.kind === 'expired') return <ExpiredPortal />

  const { data } = load

  // Only a technician grant can reach this route. The vendor's own link has no
  // grant row behind it, so landing here with one means somebody pasted the
  // wrong URL; sending them to their real portal is friendlier than a 404.
  if (data.principal.kind !== 'technician') {
    notFound()
  }

  if (!data.principal.displayName) {
    return (
      <IdentifyGate
        token={token}
        woNumber={data.workOrder.wo_number}
        propertyName={data.property?.name ?? null}
        jobTitle={data.workOrder.title}
      />
    )
  }

  return (
    <VendorPortal
      token={token}
      workOrder={data.workOrder}
      property={data.property}
      expired={data.expired}
      vendorConnectToken={data.vendorConnectToken}
      vendorChargesEnabled={data.vendorChargesEnabled}
      principalKind="technician"
      technicianGrants={[]}
    />
  )
}
