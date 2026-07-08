import { Section, Text, Button, Hr } from '@react-email/components'
import { render }                     from '@react-email/render'
import { BaseLayout }                 from './base-layout'

export interface VendorConnectInviteProps {
  vendorName:    string | null
  orgName:       string
  pmName:        string | null   // PM's full name — null when sent from the nightly cron
  woNumber:      string | null   // Work order number for context — null from cron
  onboardingUrl: string
}

export function VendorConnectInviteEmail({
  vendorName,
  orgName,
  pmName,
  woNumber,
  onboardingUrl,
}: VendorConnectInviteProps) {
  const greeting   = vendorName ? `Hi ${vendorName},` : 'Hi,'
  const senderLine = pmName
    ? `${pmName} at ${orgName}`
    : orgName
  const contextLine = woNumber
    ? `just dispatched work order ${woNumber} to you through FieldStay`
    : `uses FieldStay to manage their property operations and has added you as a vendor`

  return (
    <BaseLayout
      previewText={`${senderLine} — set up your Stripe payout account to get paid`}
      headerSub="Vendor Payments"
      footerLine="You were added as a vendor by one of our property management customers. FieldStay processes payments on their behalf — we do not manage job bookings directly."
    >
      <Text style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 16px' }}>
        {greeting}
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 14px' }}>
        <strong>{senderLine}</strong> {contextLine}.
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 14px' }}>
        To get paid for your work, you&apos;ll need to connect your bank account
        to FieldStay&apos;s payment platform. Once set up, payments are sent directly
        to your bank — no checks, no follow-up, no delays.
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 24px' }}>
        It takes <strong>3–5 minutes</strong> and is powered by{' '}
        <strong>Stripe</strong> — the same platform used by millions of businesses
        worldwide. You&apos;ll need your bank account and routing numbers handy.
      </Text>

      <Section style={{ textAlign: 'center', margin: '0 0 24px' }}>
        <Button
          href={onboardingUrl}
          style={{
            backgroundColor: '#FF6B00',
            color:           '#ffffff',
            borderRadius:    8,
            padding:         '13px 32px',
            fontWeight:      700,
            fontSize:        15,
            textDecoration:  'none',
            display:         'inline-block',
          }}
        >
          Set Up My Payout Account →
        </Button>
      </Section>

      <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />

      <Text style={{ fontSize: 13, color: '#64748b', lineHeight: 1.55, margin: '0 0 8px' }}>
        <strong>Why Stripe?</strong> Stripe is PCI-compliant and the industry
        standard for contractor payouts. FieldStay never holds your funds —
        money moves directly from the property manager&apos;s account to yours.
      </Text>

      <Text style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
        This setup link is unique to you. If you have questions about your payment
        setup, reply to this email. For questions about the work order itself,
        contact {senderLine} directly.
      </Text>
    </BaseLayout>
  )
}

export async function renderVendorConnectInviteEmail(
  props: VendorConnectInviteProps
): Promise<string> {
  return render(<VendorConnectInviteEmail {...props} />)
}
