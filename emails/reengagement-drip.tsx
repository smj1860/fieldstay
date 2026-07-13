import { Text, Section, Link } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:       string
  orgName:         string
  isConnected:     boolean
  dashboardUrl:    string
  integrationsUrl: string
  onboardingUrl:   string
  reviewCount:     number
}

export function ReengagementEmail({
  firstName,
  orgName,
  isConnected,
  dashboardUrl,
  integrationsUrl,
  onboardingUrl,
  reviewCount,
}: Props) {
  if (isConnected) {
    return (
      <EmailLayout
        preview="Your guests left reviews this week. Did you respond?"
        ctaLabel="Review responses →"
        ctaUrl={dashboardUrl}
        footerNote={`You're receiving this as part of your FieldStay onboarding for ${orgName}.`}
      >
        <Text style={heading}>One week in, {firstName}.</Text>
        <Text style={subheading}>Your guests left reviews this week. Did you respond?</Text>

        <Text style={body}>
          Since you connected your PMS, FieldStay has been watching for new
          reviews across your properties. <strong>{reviewCount}</strong>{' '}came
          in this week — RepuGuard already has draft responses ready for your
          approval.
        </Text>

        <Section style={callout}>
          <Text style={calloutTitle}>Why this matters</Text>
          <Text style={calloutItem}>
            → Guests who see a fast, thoughtful response are more likely to book direct next time.
          </Text>
          <Text style={calloutItem}>
            → A drafted response takes 30 seconds to approve — not 10 minutes to write.
          </Text>
        </Section>

        <Text style={{ ...body, marginTop: 16 }}>
          — Stephen
        </Text>
      </EmailLayout>
    )
  }

  return (
    <EmailLayout
      preview="7 days in. Here's what you're missing."
      ctaLabel="Connect your PMS →"
      ctaUrl={integrationsUrl}
      footerNote={`You're receiving this as part of your FieldStay onboarding for ${orgName}.`}
    >
      <Text style={heading}>7 days in, {firstName}.</Text>
      <Text style={subheading}>Here&apos;s what you&apos;re missing.</Text>

      <Text style={body}>
        <strong>{orgName}</strong>{' '}is set up on FieldStay, but your PMS isn&apos;t
        connected yet — which means turnovers, bookings, and same-day flags
        are still something you have to track by hand.
      </Text>

      <Section style={callout}>
        <Text style={calloutTitle}>Two minutes unlocks the rest</Text>
        <Text style={calloutItem}>→ Bookings and checkouts sync automatically</Text>
        <Text style={calloutItem}>→ Turnovers get created and assigned without you touching a spreadsheet</Text>
        <Text style={calloutItem}>→ Owner reporting fills itself in from real booking data</Text>
      </Section>

      <Text style={{ ...body, marginTop: 16 }}>
        Still setting things up?{' '}
        <Link href={onboardingUrl} style={link}>Jump back into onboarding →</Link>
      </Text>

      <Text style={{ ...body, marginTop: 16 }}>
        — Stephen
      </Text>
    </EmailLayout>
  )
}

export async function renderReengagementEmail(props: Props): Promise<string> {
  return render(<ReengagementEmail {...props} />)
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

const link: React.CSSProperties = {
  color:          '#0a1628',
  fontWeight:     600,
  textDecoration: 'underline',
}
