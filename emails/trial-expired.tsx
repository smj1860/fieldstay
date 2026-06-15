import { Text, Section } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:       string
  orgName:         string
  reactivateUrl:   string
  dataExpiresDate: string
}

export function TrialExpiredEmail({
  firstName,
  orgName,
  reactivateUrl,
  dataExpiresDate,
}: Props) {
  return (
    <EmailLayout
      preview="Your FieldStay trial has ended. Your data is safe for 30 days."
      ctaLabel="Reactivate your account →"
      ctaUrl={reactivateUrl}
      footerNote={`You're receiving this because you had a FieldStay trial for ${orgName}.`}
    >
      <Text style={heading}>Your trial has ended, {firstName}.</Text>

      <Text style={body}>
        Your FieldStay account is paused as of today. Your data —
        properties, crew, checklists, inventory, and turnovers — is
        safely held until <strong>{dataExpiresDate}</strong>.
      </Text>

      <Text style={body}>
        Subscribe anytime before then and everything picks up exactly
        where you left off. Nothing to reconfigure.
      </Text>

      <Section style={planBox}>
        <Text style={planBoxTitle}>Plans start at $199/month</Text>
        <Text style={planBoxBody}>
          1–15 properties · Unlimited crew · Full OwnerRez sync ·
          Inventory · Maintenance · Owner portal
        </Text>
      </Section>

      <Text style={body}>
        If you have questions about plans or need help deciding what&apos;s
        right for your portfolio, just reply to this email.
      </Text>

      <Text style={signature}>— Stephen</Text>
    </EmailLayout>
  )
}

export async function renderTrialExpiredEmail(props: Props): Promise<string> {
  return render(<TrialExpiredEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize:   24,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 20px',
  lineHeight: '1.2',
}

const body: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 16px',
}

const planBox: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  border:          '1px solid #e2e8f0',
  borderRadius:    10,
  padding:         '16px 20px',
  margin:          '8px 0 24px',
}

const planBoxTitle: React.CSSProperties = {
  fontSize:   14,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 4px',
}

const planBoxBody: React.CSSProperties = {
  fontSize:   13,
  color:      '#5a6a7a',
  margin:     0,
  lineHeight: '1.5',
}

const signature: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  margin:     '8px 0 0',
  fontWeight: 500,
}
