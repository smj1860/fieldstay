import { withPropertyDefaults } from '@/lib/properties/defaults'
import { requireProperty } from '@/lib/auth'
import { DetailsForm } from './details-form'
import { Card } from '@/components/ui/Card'
import { reportError } from '@/lib/observability/report-error'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Property Details' }

interface Props { params: Promise<{ id: string }> }

export default async function DetailsPage({ params }: Props) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  // A discarded error here was silent DESTRUCTION of a physical-access
  // credential, not just a bad render. The chain: read fails -> doorCode null
  // -> details-form renders the input with defaultValue='' -> the next save of
  // this form (even one only editing the property name) submits an empty
  // door_code -> saveDetails coerces '' to null -> store_property_door_code's
  // NULL branch DELETEs the vault secret and nulls door_code_secret_id.
  //
  // So the read failing must never render as "there is no door code". The two
  // cases are now distinct: doorCode === null with readFailed false means
  // genuinely unset, and readFailed true means unknown — the form then leaves
  // the stored value alone instead of overwriting it with blank.
  let doorCode: string | null = null
  let doorCodeReadFailed = false
  if (property.door_code_secret_id) {
    const { data, error } = await supabase.rpc('read_property_door_code', {
      p_property_id: property.id,
      p_org_id:      membership.org_id,
    })
    if (error) {
      // Never log the code itself — only that the read failed.
      console.error('[DetailsPage] door code read failed', error)
      reportError(error, {
        site:  'page.properties.setup.details.readDoorCode',
        orgId: membership.org_id,
      })
      doorCodeReadFailed = true
    } else {
      doorCode = (data as string | null) ?? null
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Property Details</h2>
      <p className="text-sm text-accent-500 mb-6">Name, address, check-in/out times, and access info.</p>
      <DetailsForm
        property={withPropertyDefaults(property)}
        doorCode={doorCode}
        doorCodeReadFailed={doorCodeReadFailed}
      />
    </Card>
  )
}
