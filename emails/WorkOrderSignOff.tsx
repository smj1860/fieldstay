import { Hr, Section, Text } from '@react-email/components'
import { EmailLayout } from './components/email-layout'

interface WorkOrderSignOffEmailProps {
  woNumber:        string
  title:           string
  propertyName:    string
  propertyAddress: string
  vendorName:      string | null
  signOffNotes:    string | null
  signedOffAt:     string
  pmName:          string
}

export default function WorkOrderSignOffEmail({
  woNumber        = 'WO-2025-06-0042',
  title           = 'HVAC Maintenance',
  propertyName    = 'The Riverside Retreat',
  propertyAddress = '1247 Sunrise Blvd, Austin TX 78701',
  vendorName      = 'Mike Johnson',
  signOffNotes    = null,
  signedOffAt     = new Date().toISOString(),
  pmName          = 'Sarah',
}: WorkOrderSignOffEmailProps) {

  const formattedDate = new Date(signedOffAt).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit'
  } as Intl.DateTimeFormatOptions)

  return (
    <EmailLayout preview={`✓ Work Complete — ${woNumber} · ${propertyName}`}>
      <Text style={{ fontSize: 20, color: '#0a1628', fontWeight: 700, margin: '0 0 4px' }}>
        Work Order Complete
      </Text>
      <Text style={{ fontSize: 13, color: 'var(--accent-green, #16A34A)', margin: '0 0 20px' }}>
        {formattedDate}
      </Text>

      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 20px' }}>
        Hi {pmName}, your work order has been signed off
        {vendorName ? ` by ${vendorName}` : ''}.
      </Text>

      <Section style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: '14px 16px' }}>
        {[
          ['Work Order', woNumber],
          ['Job',        title],
          ['Property',   propertyName],
          ['Address',    propertyAddress],
        ].map(([label, value]) => (
          <Text key={label} style={{ fontSize: 13, color: '#0a1628', margin: '0 0 8px' }}>
            <span style={{ color: '#64748b' }}>{label}: </span>
            <span style={{ fontWeight: 600 }}>{value}</span>
          </Text>
        ))}
      </Section>

      {signOffNotes && (
        <>
          <Hr style={{ borderColor: '#e2e8f0', margin: '20px 0 16px' }} />
          <Text style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
            Contractor Notes
          </Text>
          <Section style={{ backgroundColor: '#f8fafc', borderRadius: 6, padding: '12px 14px' }}>
            <Text style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, margin: 0 }}>
              {signOffNotes}
            </Text>
          </Section>
        </>
      )}
    </EmailLayout>
  )
}
