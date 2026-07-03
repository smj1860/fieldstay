import { Text, Section, Row, Column, Link } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:       string
  orgName:         string
  dashboardUrl:    string
  propertiesUrl:   string
  crewUrl:         string
  integrationsUrl: string
}

export function WelcomeEmail({
  firstName,
  orgName,
  dashboardUrl,
  propertiesUrl,
  crewUrl,
  integrationsUrl,
}: Props) {
  return (
    <EmailLayout
      preview={`Welcome to FieldStay, ${firstName}. Your property operations platform is ready.`}
      ctaLabel="Go to your dashboard →"
      ctaUrl={dashboardUrl}
      footerNote={`You're receiving this because you created a FieldStay account for ${orgName}.`}
    >
      <Text style={heading}>Welcome to FieldStay, {firstName}.</Text>
      <Text style={subheading}>Your property operations platform is ready.</Text>

      <Text style={body}>
        We set up your account for <strong>{orgName}</strong>. Your 14-day trial
        gives you full access to everything — turnovers, crew management, inventory,
        maintenance, RepuGuard, and owner reporting. No credit card required and no surprises.
      </Text>

      <Text style={sectionLabel}>THREE THINGS TO DO FIRST</Text>

      <Section style={stepCard}>
        <Row>
          <Column style={stepNum}>1</Column>
          <Column>
            <Text style={stepTitle}>Connect OwnerRez</Text>
            <Text style={stepDesc}>
              Your bookings and properties sync automatically within minutes.{' '}
              <Link href={integrationsUrl} style={link}>Settings → Integrations →</Link>
            </Text>
          </Column>
        </Row>
      </Section>

      <Section style={stepCard}>
        <Row>
          <Column style={stepNum}>2</Column>
          <Column>
            <Text style={stepTitle}>Add your crew</Text>
            <Text style={stepDesc}>
              Invite cleaners and maintenance staff. They get a free mobile
              app — no App Store required.{' '}
              <Link href={crewUrl} style={link}>Add crew →</Link>
            </Text>
          </Column>
        </Row>
      </Section>

      <Section style={{ ...stepCard, marginBottom: 0 }}>
        <Row>
          <Column style={stepNum}>3</Column>
          <Column>
            <Text style={stepTitle}>Set up your first property</Text>
            <Text style={stepDesc}>
              Add inventory with par levels, your turnover checklist, assets, and maintenance schedules.{' '}
              <Link href={propertiesUrl} style={link}>View properties →</Link>
            </Text>
          </Column>
        </Row>
      </Section>

      <Text style={{ ...body, marginTop: 36, padding: '14px 18px', borderRadius: 10,
                      background: '#f0f4ff', borderLeft: '4px solid #FCD116' }}>
        Once your first property is fully set up, FieldStay runs on autopilot — turnovers assign
        themselves, inventory restocks trigger automatically, and your owners get a live P&amp;L
        view without you lifting a finger.
      </Text>

      <Text style={{ ...body, marginTop: 16 }}>
        If you need anything during setup, just reply to this email or use the
        chat in the app. I built FieldStay to make property operations actually
        manageable — and I want to make sure it does that for you.
      </Text>

      <Text style={signature}>— Stephen</Text>
    </EmailLayout>
  )
}

export async function renderWelcomeEmail(props: Props): Promise<string> {
  return render(<WelcomeEmail {...props} />)
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

const sectionLabel: React.CSSProperties = {
  fontSize:      11,
  fontWeight:    700,
  color:         '#94a3b8',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin:        '28px 0 12px',
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
