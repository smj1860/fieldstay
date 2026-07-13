import { Text } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  guestName:    string
  propertyName: string
  optInUrl:     string
  guidebookUrl: string
}

export function GuestPreArrivalEmail({ guestName, propertyName, optInUrl, guidebookUrl }: Props) {
  return (
    <EmailLayout
      preview={`Get your door code by text — ${propertyName}`}
      ctaLabel="Text Me My Door Code →"
      ctaUrl={optInUrl}
      footerNote="Opting in lets us text your door code and helpful updates during your stay. Reply STOP at any time to opt out."
    >
      <Text style={heading}>Almost there, {guestName}!</Text>
      <Text style={body}>
        Your stay at <strong>{propertyName}</strong>{' '}is coming up. The fastest way
        to get your door code is by text — tap the button below to opt in and
        we&apos;ll send it straight to your phone before check-in.
      </Text>
      <Text style={body}>
        Prefer to read everything online instead? View your{' '}
        <a href={guidebookUrl}>digital guidebook</a> for check-in instructions,
        wifi, house rules, and local recommendations.
      </Text>
    </EmailLayout>
  )
}

export async function renderGuestPreArrivalEmail(props: Props): Promise<string> {
  return render(<GuestPreArrivalEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize: 24, fontWeight: 700, color: '#0a1628', margin: '0 0 16px',
}

const body: React.CSSProperties = {
  fontSize: 15, color: '#374151', lineHeight: '1.6', margin: '0 0 14px',
}
