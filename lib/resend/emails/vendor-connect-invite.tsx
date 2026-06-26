import { Section, Text, Button, Hr }  from '@react-email/components'
import { render }                      from '@react-email/render'
import { BaseLayout }                  from './base-layout'

export interface VendorConnectInviteProps {
  vendorName:    string | null
  orgName:       string
  onboardingUrl: string
}

export function VendorConnectInviteEmail({
  vendorName,
  orgName,
  onboardingUrl,
}: VendorConnectInviteProps) {
  const greeting = vendorName ? `Hi ${vendorName},` : 'Hi,'

  return (
    <BaseLayout
      previewText={`${orgName} pays invoices via Stripe Connect — set up your payout account`}
      headerSub="Vendor Payments"
      footerLine="You were added as a vendor by one of our property management customers."
    >
      <Text style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
        {greeting}
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.6, margin: '0 0 16px' }}>
        <strong>{orgName}</strong> has added you as a vendor in FieldStay.
        When you complete work orders, invoices are paid directly to your bank
        account via <strong>Stripe Connect</strong> — no checks, no delays.
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.6, margin: '0 0 24px' }}>
        Setting up your payout account takes about 2 minutes. You'll need your
        bank account details and business information.
      </Text>

      <Section style={{ textAlign: 'center', margin: '0 0 24px' }}>
        <Button
          href={onboardingUrl}
          style={{
            backgroundColor: '#FF6B00',
            color:           '#ffffff',
            borderRadius:    8,
            padding:         '12px 28px',
            fontWeight:      700,
            fontSize:        14,
            textDecoration:  'none',
            display:         'inline-block',
          }}
        >
          Set Up Stripe Payout Account →
        </Button>
      </Section>

      <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />

      <Text style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
        This link is unique to you and expires if unused for 90 days.
        If you have questions, contact {orgName} directly.
        FieldStay processes payments — we do not manage job bookings.
      </Text>
    </BaseLayout>
  )
}

export async function renderVendorConnectInviteEmail(
  props: VendorConnectInviteProps
): Promise<string> {
  return render(<VendorConnectInviteEmail {...props} />)
}
