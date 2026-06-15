import { Text } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  crewName:  string
  orgName:   string
  inviteUrl: string
}

export function CrewInviteEmail({ crewName, orgName, inviteUrl }: Props) {
  return (
    <EmailLayout
      preview={`${orgName} invited you to join their crew on FieldStay`}
      ctaLabel="Accept & create account →"
      ctaUrl={inviteUrl}
      footerNote="If you didn't expect this invitation, you can safely ignore this email."
    >
      <Text style={heading}>You&apos;ve been invited to join {orgName}</Text>
      <Text style={body}>
        Hi {crewName} — {orgName} has invited you to their crew on FieldStay.
      </Text>
      <Text style={body}>
        FieldStay is how your team manages property turnovers. You&apos;ll be
        able to view your assigned turnovers, complete cleaning checklists,
        and capture photos — all from your phone. No app store required.
      </Text>
      <Text style={body}>
        Create your account by clicking the button below. It takes less
        than a minute.
      </Text>
    </EmailLayout>
  )
}

export async function renderCrewInviteEmail(props: Props): Promise<string> {
  return render(<CrewInviteEmail {...props} />)
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
