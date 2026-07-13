import { Text, Section, Row, Column, Link } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:       string
  orgName:         string
  integrationsUrl: string
  onboardingUrl:   string
  dashboardUrl:    string
}

export function WelcomeEmailV2({
  firstName,
  orgName,
  integrationsUrl,
  onboardingUrl,
  dashboardUrl,
}: Props) {
  return (
    <EmailLayout
      preview="You made the right call. Here's where to start."
      ctaLabel="Finish setup →"
      ctaUrl={onboardingUrl}
      footerNote={`You're receiving this because you created a FieldStay account for ${orgName}.`}
    >
      <Text style={heading}>You made the right call, {firstName}.</Text>
      <Text style={subheading}>Here&apos;s where to start.</Text>

      <Text style={body}>
        <strong>{orgName}</strong>{' '}is live on FieldStay. Your 14-day trial has full
        access — turnovers, crew scheduling, inventory, maintenance, and owner
        reporting, all running without you having to remember any of it.
      </Text>

      <Section style={stepCard}>
        <Row>
          <Column style={stepNum}>1</Column>
          <Column>
            <Text style={stepTitle}>Connect your PMS</Text>
            <Text style={stepDesc}>
              Bookings, checkouts, and turnovers sync automatically — no manual entry.{' '}
              <Link href={integrationsUrl} style={link}>Connect now →</Link>
            </Text>
          </Column>
        </Row>
      </Section>

      <Section style={{ ...stepCard, marginBottom: 0 }}>
        <Row>
          <Column style={stepNum}>2</Column>
          <Column>
            <Text style={stepTitle}>Finish the setup wizard</Text>
            <Text style={stepDesc}>
              Ten minutes gets your first property, crew, and checklists ready to run.{' '}
              <Link href={dashboardUrl} style={link}>Go to your dashboard →</Link>
            </Text>
          </Column>
        </Row>
      </Section>

      <Text style={{ ...body, marginTop: 16 }}>
        Reply to this email any time — I read every one.
      </Text>

      <Text style={signature}>— Stephen</Text>
    </EmailLayout>
  )
}

export async function renderWelcomeEmailV2(props: Props): Promise<string> {
  return render(<WelcomeEmailV2 {...props} />)
}

// ── Styles ────────────────────────────────────────────────────────────

const heading: React.CSSProperties = {
  fontSize:   26,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 6px',
  lineHeight: '1.2',
}

const subheading: React.CSSProperties = {
  fontSize:   16,
  color:      '#5a6a7a',
  margin:     '0 0 28px',
  fontWeight: 400,
}

const body: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 20px',
}

const stepCard: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderRadius:    10,
  padding:         '16px 20px',
  marginBottom:    10,
}

const stepNum: React.CSSProperties = {
  backgroundColor: '#FCD116',
  color:           '#0a1628',
  fontWeight:      800,
  fontSize:        14,
  width:           28,
  height:          28,
  borderRadius:    '50%',
  textAlign:       'center',
  lineHeight:      '28px',
  verticalAlign:   'top',
  marginRight:     14,
  flexShrink:      0,
}

const stepTitle: React.CSSProperties = {
  fontSize:   14,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 2px',
}

const stepDesc: React.CSSProperties = {
  fontSize:   13,
  color:      '#5a6a7a',
  margin:     0,
  lineHeight: '1.5',
}

const link: React.CSSProperties = {
  color:          '#0a1628',
  fontWeight:     600,
  textDecoration: 'underline',
}

const signature: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  margin:     '8px 0 0',
  fontWeight: 500,
}
