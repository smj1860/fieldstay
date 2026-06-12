import { Section, Text, Button, Hr } from '@react-email/components'
import { render } from '@react-email/render'
import { BaseLayout } from './base-layout'

export interface TeamInviteEmailProps {
  inviterEmail: string
  orgName:      string
  acceptUrl:    string
}

export function TeamInviteEmail({ inviterEmail, orgName, acceptUrl }: TeamInviteEmailProps) {
  return (
    <BaseLayout
      previewText={`You've been invited to join ${orgName} on FieldStay`}
      headerSub="Team Invitation"
      footerLine="This invitation expires in 7 days. If you didn't expect this, you can ignore it."
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 12px' }}>
        You're invited to FieldStay
      </Text>
      <Text style={{ fontSize: 14, color: '#475569', lineHeight: 1.6, margin: '0 0 24px' }}>
        <strong>{inviterEmail}</strong> has invited you to join <strong>{orgName}</strong> on FieldStay as a team admin.
      </Text>

      <Button
        href={acceptUrl}
        style={{
          backgroundColor: '#FCD116',
          color: '#0a1628',
          fontWeight: 700,
          fontSize: 15,
          padding: '12px 28px',
          borderRadius: 8,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Accept Invitation →
      </Button>
    </BaseLayout>
  )
}

export async function renderTeamInviteEmail(props: TeamInviteEmailProps): Promise<string> {
  return render(<TeamInviteEmail {...props} />)
}
