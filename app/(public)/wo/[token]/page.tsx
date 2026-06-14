import { getWorkOrderByToken }   from '@/app/actions/work-order-public'
import { WorkOrderPublicClient } from './WorkOrderPublicClient'
import type { Metadata }         from 'next'

interface Props {
  params: Promise<{ token: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title:  'Work Order — TradeSuite Pro',
    description: 'View and sign off your work order',
    robots: { index: false, follow: false },
  }
}

export default async function WorkOrderPublicPage({ params }: Props) {
  const { token } = await params

  const result = await getWorkOrderByToken(token)

  if (result.error || !result.data) {
    return (
      <div style={{
        minHeight:'100vh', background:'#0E0E0E',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{ textAlign:'center', color:'#fff', padding:32 }}>
          <div style={{ fontSize:48, marginBottom:16 }}>⚠️</div>
          <div style={{ fontSize:20, fontWeight:700, marginBottom:8 }}>
            Work Order Not Found
          </div>
          <div style={{ color:'#666', fontSize:14, maxWidth:320, margin:'0 auto' }}>
            {result.error ?? 'This link is invalid or has expired. Contact your property manager.'}
          </div>
        </div>
      </div>
    )
  }

  const wo = result.data

  return (
    <WorkOrderPublicClient
      token={token}
      workOrder={{
        id:              wo.id,
        woNumber:        wo.wo_number ?? '',
        status:          wo.status,
        title:           wo.title,
        description:     wo.description,
        nteAmount:       wo.nte_amount as number | null,
        lockboxCode:     wo.lockbox_code,
        parkingNotes:    wo.parking_notes,
        accessNotes:     wo.access_notes,
        propertyName:    wo.properties?.name    ?? '',
        propertyAddress: wo.properties?.address ?? '',
        vendorName:      wo.vendors?.name       ?? null,
        dispatcherName:  wo.organizations?.name ?? 'Your Property Manager',
        dispatcherOrg:   wo.organizations?.name ?? '',
        dispatcherPhone: null,
        alreadySigned:   !!wo.public_signed_off_at,
        signedOffAt:     wo.public_signed_off_at ?? null,
        signOffNotes:    wo.sign_off_notes       ?? null,
      }}
    />
  )
}
