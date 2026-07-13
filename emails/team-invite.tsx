import { Text } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  inviterEmail: string
  orgName:      string
  acceptUrl:    string
}

export function TeamInviteEmail({ inviterEmail, orgName, acceptUrl }: Props) {
  return (
    <EmailLayout
      preview={`${inviterEmail} invited you to join ${orgName} on FieldStay`}
      ctaLabel="Accept Invitation →"
      ctaUrl={acceptUrl}
      footerNote="This invitation expires in 7 days. If you didn't expect this, you can ignore it."
    >
      <Text style={heading}>You&apos;re invited to FieldStay</Text>
      <Text style={body}>
        <strong>{inviterEmail}</strong>{' '}has invited you to join{' '}
        <strong>{orgName}</strong>{' '}on FieldStay as a team administrator.
      </Text>
      <Text style={body}>
        FieldStay is a property operations platform for short-term rental
        managers. As an admin you&apos;ll have full access to properties,
        turnovers, crew, and maintenance.
      </Text>
    </EmailLayout>
  )
}

export async function renderTeamInviteEmail(props: Props): Promise<string> {
  return render(<TeamInviteEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize:   24,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 16px',
}

const body: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 14px',
}
