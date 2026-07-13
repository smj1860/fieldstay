import { Section, Text, Hr } from '@react-email/components'
import { render }             from '@react-email/render'
import { EmailLayout }        from '@/emails/components/email-layout'

export interface VendorComplianceNudgeProps {
  vendorName: string
  orgName:    string
  docLabel:   string
  expiryDate: string
  daysUntil:  number
}

export function VendorComplianceNudgeEmail({
  vendorName,
  orgName,
  docLabel,
  expiryDate,
  daysUntil,
}: VendorComplianceNudgeProps) {
  const formattedExpiry = new Date(expiryDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const dayWord = daysUntil !== 1 ? 'days' : 'day'

  return (
    <EmailLayout
      preview={`Your ${docLabel} expires in ${daysUntil} ${dayWord}`}
      headerSub="Vendor Compliance"
      footerNote="You're receiving this because you're listed as a vendor with one of our property management customers."
    >
      <Text style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 16px' }}>
        Hi {vendorName},
      </Text>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 14px' }}>
        Just a heads up — your <strong>{docLabel}</strong> on file with{' '}
        <strong>{orgName}</strong> is set to expire on <strong>{formattedExpiry}</strong>{' '}
        ({daysUntil} {dayWord} from now).
      </Text>

      <Section
        style={{
          backgroundColor: '#fffbeb',
          border:          '1px solid #fde68a',
          borderRadius:    8,
          padding:         '16px 20px',
          margin:          '0 0 20px',
        }}
      >
        <Text style={{ fontSize: 13, color: '#92400e', fontWeight: 700, margin: '0 0 4px' }}>
          {docLabel}
        </Text>
        <Text style={{ fontSize: 13, color: '#92400e', margin: 0 }}>
          Expires {formattedExpiry}
        </Text>
      </Section>

      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.65, margin: '0 0 14px' }}>
        To avoid any interruption to new work order assignments, please send an
        updated copy to {orgName} whenever your renewal is ready.
      </Text>

      <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />

      <Text style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
        Questions about this document requirement? Reply to this email or contact{' '}
        {orgName} directly.
      </Text>
    </EmailLayout>
  )
}

export async function renderVendorComplianceNudgeEmail(
  props: VendorComplianceNudgeProps
): Promise<string> {
  return render(<VendorComplianceNudgeEmail {...props} />)
}
