import { Section, Text, Hr } from '@react-email/components'
import { render }             from '@react-email/render'
import { EmailLayout }        from '@/emails/components/email-layout'

export interface VendorInvoicePaidProps {
  vendorName:     string | null
  orgName:        string
  woTitle:        string
  woNumber:       string | null
  propertyName:   string | null
  invoiceNumber:  string
  amountPaid:     number
}

export function VendorInvoicePaidEmail({
  vendorName,
  orgName,
  woTitle,
  woNumber,
  propertyName,
  invoiceNumber,
  amountPaid,
}: VendorInvoicePaidProps) {
  const greeting = vendorName ? `Hi ${vendorName},` : 'Hi,'
  const amount   = amountPaid.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  return (
    <EmailLayout
      preview={`You've been paid ${amount} for ${woTitle}`}
      headerSub="Vendor Payments"
      footerNote="You were added as a vendor by one of our property management customers. FieldStay processes payments on their behalf — we do not manage job bookings directly."
    >
      <Text style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 16px' }}>
        {greeting}
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 14px' }}>
        You&apos;ve been paid <strong>{amount}</strong>{' '}by <strong>{orgName}</strong> for{' '}
        {woNumber ? <>work order <strong>{woNumber}</strong></> : 'the following work order'}
        {propertyName ? <> at <strong>{propertyName}</strong></> : ''}.
      </Text>

      <Section
        style={{
          backgroundColor: '#f0fdf4',
          border:          '1px solid #bbf7d0',
          borderRadius:    8,
          padding:         '16px 20px',
          margin:          '0 0 20px',
        }}
      >
        <Text style={{ fontSize: 13, color: '#166534', fontWeight: 700, margin: '0 0 6px' }}>
          {woTitle}
        </Text>
        <Text style={{ fontSize: 13, color: '#166534', margin: '0 0 2px' }}>
          Invoice {invoiceNumber}
        </Text>
        <Text style={{ fontSize: 18, color: '#166534', fontWeight: 800, margin: '6px 0 0' }}>
          {amount} paid
        </Text>
      </Section>

      <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />

      <Text style={{ fontSize: 13, color: '#64748b', lineHeight: 1.55, margin: '0 0 8px' }}>
        Funds are sent directly to the bank account connected to your Stripe payout
        account and typically arrive within a few business days, depending on your bank.
      </Text>

      <Text style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
        Questions about this payment? Reply to this email. For questions about the
        work itself, contact {orgName} directly.
      </Text>
    </EmailLayout>
  )
}

export async function renderVendorInvoicePaidEmail(
  props: VendorInvoicePaidProps
): Promise<string> {
  return render(<VendorInvoicePaidEmail {...props} />)
}
