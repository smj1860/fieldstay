import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { VendorPortal } from './vendor-portal'
import { loadPortalPage } from './load-portal'
import { ExpiredPortal } from './expired-portal'

export const metadata: Metadata = { title: 'Work Order | FieldStay' }

/**
 * The VENDOR's own link, from the dispatch email.
 *
 * Everything below the token lives in `loadPortalPage`, shared with the
 * technician page at `/work-orders/t/[token]` so the same screen is not built
 * from two query shapes.
 */
export default async function VendorPortalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const load = await loadPortalPage(token)
  if (load.kind === 'not_found') notFound()

  // Expiry keeps the portal's own "Link Expired, contact the property manager"
  // screen rather than becoming a 404. The work order itself is not loaded in
  // that case, so this passes the minimum the shell needs to render it.
  if (load.kind === 'expired') return <ExpiredPortal />

  const { data } = load

  return (
    <VendorPortal
      token={token}
      workOrder={data.workOrder}
      property={data.property}
      expired={data.expired}
      vendorConnectToken={data.vendorConnectToken}
      vendorChargesEnabled={data.vendorChargesEnabled}
      principalKind={data.principal.kind}
      technicianGrants={data.technicianGrants}
    />
  )
}
