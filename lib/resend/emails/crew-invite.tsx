import { Text, Button, Hr, Section } from '@react-email/components'
import { render }                     from '@react-email/render'
import { BaseLayout }                 from './base-layout'

export interface CrewInviteEmailProps {
  crewName:  string
  orgName:   string
  acceptUrl: string
}

export function CrewInviteEmail({ crewName, orgName, acceptUrl }: CrewInviteEmailProps) {
  return (
    <BaseLayout
      previewText={`${orgName} has invited you to join their crew on FieldStay`}
      headerSub="Crew Invitation"
      footerLine="This link expires in 7 days. Ignore if unexpected."
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 10px' }}>
        Hi {crewName},
      </Text>
      <Text style={{ fontSize: 14, color: '#475569', lineHeight: 1.7, margin: '0 0 20px' }}>
        <strong style={{ color: '#0f172a' }}>{orgName}</strong> has invited you to join their team
        on FieldStay — the app you'll use to view your cleaning assignments, complete checklists,
        and submit inventory counts.
      </Text>

      <Button
        href={acceptUrl}
        style={{
          backgroundColor: '#FCD116',
          color: '#0a1628',
          fontWeight: 800,
          fontSize: 15,
          padding: '14px 32px',
          borderRadius: 8,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Accept Invitation →
      </Button>

      <Hr style={{ borderColor: '#e2e8f0', margin: '28px 0 16px' }} />

      <Section style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: '14px 16px', borderLeft: '3px solid #FCD116' }}>
        <Text style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>
          Install on your phone for the best experience
        </Text>
        <Text style={{ fontSize: 13, color: '#475569', margin: 0, lineHeight: 1.65 }}>
          After activating, open the app on your phone and tap your browser menu →
          "Add to Home Screen" (iPhone) or "Install App" (Android).
        </Text>
      </Section>
    </BaseLayout>
  )
}

export async function renderCrewInviteEmail(props: CrewInviteEmailProps): Promise<string> {
  return render(<CrewInviteEmail {...props} />)
}
