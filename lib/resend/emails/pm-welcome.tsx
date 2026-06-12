import {
  Html, Head, Body, Container, Section, Text, Button, Hr, Preview,
} from '@react-email/components'
import { render } from '@react-email/render'

export interface PmWelcomeEmailProps {
  orgName: string
  setupUrl: string
}

export function PmWelcomeEmail({ orgName, setupUrl }: PmWelcomeEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Welcome to FieldStay — let's get {orgName} set up</Preview>
      <Body style={{ backgroundColor: '#f1f5f9', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: 600, margin: '32px auto', padding: 0 }}>

          {/* Header */}
          <Section style={{ backgroundColor: '#0a1628', borderRadius: '12px 12px 0 0', padding: '32px 32px 24px' }}>
            <Text style={{ color: '#FCD116', fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 8px', lineHeight: 1 }}>
              FieldStay
            </Text>
            <Text style={{ color: '#94a3b8', fontSize: 14, margin: 0, lineHeight: 1.4 }}>
              Property operations, automated.
            </Text>
          </Section>

          {/* Body */}
          <Section style={{ backgroundColor: '#ffffff', padding: '32px 32px 24px', borderRadius: '0 0 12px 12px' }}>
            <Text style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: '0 0 12px', lineHeight: 1.2 }}>
              Welcome to FieldStay
            </Text>
            <Text style={{ fontSize: 15, color: '#475569', lineHeight: 1.6, margin: '0 0 24px' }}>
              Your account for <strong>{orgName}</strong> is ready. Complete the setup wizard to
              connect your properties, add crew, and start automating turnovers and work orders.
            </Text>

            <Button
              href={setupUrl}
              style={{
                backgroundColor: '#FCD116',
                color: '#0a1628',
                fontWeight: 700,
                fontSize: 15,
                padding: '14px 32px',
                borderRadius: 8,
                textDecoration: 'none',
                display: 'block',
                textAlign: 'center',
              }}
            >
              Start setup →
            </Button>

            <Hr style={{ borderColor: '#e2e8f0', margin: '28px 0 20px' }} />

            <Text style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 10px' }}>
              What you can do with FieldStay
            </Text>
            {[
              'Sync bookings from OwnerRez automatically',
              'Assign crew to turnovers — manually or on autopilot',
              'Create and dispatch work orders to vendors',
              'Track inventory par levels and auto-build Kroger carts',
              'Give property owners a real-time financial dashboard',
            ].map((item) => (
              <Text key={item} style={{ fontSize: 13, color: '#475569', margin: '0 0 6px', lineHeight: 1.5 }}>
                · {item}
              </Text>
            ))}
          </Section>

          {/* Footer */}
          <Section style={{ padding: '16px 32px 24px', textAlign: 'center' }}>
            <Text style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>
              FieldStay · fieldstay.app
            </Text>
          </Section>

        </Container>
      </Body>
    </Html>
  )
}

export async function renderPmWelcomeEmail(props: PmWelcomeEmailProps): Promise<string> {
  return render(<PmWelcomeEmail {...props} />)
}
