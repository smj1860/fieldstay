import { Text, Section, Link } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:    string
  dashboardUrl: string
  turnoversUrl: string
}

export function FrictionForecasterEmail({
  firstName,
  dashboardUrl,
  turnoversUrl,
}: Props) {
  return (
    <EmailLayout
      preview="It's 7:00 AM. Here's what FieldStay already knows."
      ctaLabel="See today's turnovers →"
      ctaUrl={turnoversUrl}
      footerNote="You're receiving this as part of your FieldStay onboarding."
    >
      <Text style={heading}>It&apos;s 7:00 AM, {firstName}.</Text>
      <Text style={subheading}>Here&apos;s what FieldStay already knows.</Text>

      <Text style={body}>
        Somewhere in your portfolio, a same-day turnover is tight, a crew
        member is double-booked, or an owner is about to ask why a checkout
        ran late. FieldStay catches that before it becomes a phone call —
        not after.
      </Text>

      <Section style={callout}>
        <Text style={calloutTitle}>What&apos;s running on autopilot right now</Text>
        <Text style={calloutItem}>→ Turnover assignments, matched to crew availability and location</Text>
        <Text style={calloutItem}>→ Same-day turnover flags, before checkout not after</Text>
        <Text style={calloutItem}>→ Inventory levels, checked against par on every count</Text>
      </Section>

      <Text style={{ ...body, marginTop: 24 }}>
        Take a look at your <strong>Turnovers</strong> board — it&apos;s already
        populated with what&apos;s coming this week. Or see everything at a
        glance from your <Link href={dashboardUrl}>dashboard</Link>.
      </Text>

      <Text style={{ ...body, marginTop: 16 }}>
        Questions about what you&apos;re seeing? Just reply — I&apos;m Stephen,
        not a support queue.
      </Text>

      <Text style={signature}>— Stephen</Text>
    </EmailLayout>
  )
}

export async function renderFrictionForecasterEmail(props: Props): Promise<string> {
  return render(<FrictionForecasterEmail {...props} />)
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

const callout: React.CSSProperties = {
  backgroundColor: '#f0f4ff',
  borderLeft:      '4px solid #FCD116',
  borderRadius:    10,
  padding:         '18px 20px',
  margin:          '0 0 20px',
}

const calloutTitle: React.CSSProperties = {
  fontSize:      11,
  fontWeight:    700,
  color:         '#94a3b8',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  margin:        '0 0 10px',
}

const calloutItem: React.CSSProperties = {
  fontSize:   14,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 6px',
}

const signature: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  margin:     '8px 0 0',
  fontWeight: 500,
}
