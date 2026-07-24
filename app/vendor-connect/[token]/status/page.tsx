import { createServiceClient } from '@/lib/supabase/server'

export default async function VendorConnectStatusPage({
  params,
  searchParams,
}: {
  params:       Promise<{ token: string }>
  searchParams: Promise<{ already_onboarded?: string }>
}) {
  const { token }       = await params
  const { already_onboarded } = await searchParams
  const supabase        = createServiceClient({ publicSurface: 'vendor-connect--token--status' })

  const { data: vendor } = await supabase
    .from('vendors')
    .select('name, stripe_connect_charges_enabled')
    .eq('stripe_connect_token', token)
    .eq('is_active', true)
    .single()

  const isComplete = vendor?.stripe_connect_charges_enabled || already_onboarded === 'true'
  const vendorName = vendor?.name ?? 'Vendor'

  return (
    <div style={{
      minHeight:       '100vh',
      backgroundColor: '#1A1A1A',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
      padding:         '16px',
      fontFamily:      '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    }}>
      <div style={{
        backgroundColor: '#ffffff',
        borderRadius:    16,
        padding:         '40px 32px',
        maxWidth:        400,
        width:           '100%',
        textAlign:       'center',
        boxShadow:       '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <p style={{ color: '#FF6B00', fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', margin: '0 0 4px' }}>
          TradeSuite
        </p>
        <p style={{ color: '#94a3b8', fontSize: 10, margin: '0 0 32px', letterSpacing: '0.05em' }}>
          Powered by FieldStay
        </p>

        <div style={{
          width: 64, height: 64,
          borderRadius: '50%',
          backgroundColor: isComplete ? '#dcfce7' : '#fff7ed',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px',
          fontSize: 28,
        }}>
          {isComplete ? '✓' : '⏳'}
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 12px' }}>
          {isComplete ? 'Payout account ready' : 'Almost there'}
        </h1>

        <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6, margin: '0 0 24px' }}>
          {isComplete
            ? `You're all set, ${vendorName}. When you submit invoices through FieldStay, payments will be deposited directly to your bank account.`
            : 'Stripe is verifying your account information. This usually takes a few minutes. You can close this window — we\'ll let you know when your payout account is active.'}
        </p>

        {!isComplete && (
          <a
            href={`/api/vendor-connect/${token}/onboard`}
            style={{
              display: 'inline-block',
              backgroundColor: '#FF6B00',
              color: '#ffffff',
              borderRadius: 8,
              padding: '10px 24px',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Continue Setup
          </a>
        )}
      </div>
    </div>
  )
}
