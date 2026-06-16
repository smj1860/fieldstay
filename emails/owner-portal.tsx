import { Text } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  ownerName:    string
  orgName:      string
  propertyName: string
  portalUrl:    string
}

export function OwnerPortalEmail({ ownerName, orgName, propertyName, portalUrl }: Props) {
  return (
    <EmailLayout
      preview={`Your owner portal for ${propertyName} is ready`}
      ctaLabel="View My Owner Portal →"
      ctaUrl={portalUrl}
      footerNote="This link provides access to your property financials. Keep it private. Contact your property manager if you did not expect this email."
    >
      <Text style={heading}>Your Owner Portal Is Ready</Text>
      <Text style={body}>
        Hi {ownerName} — {orgName} has shared your property&apos;s financial
        dashboard with you.
      </Text>
      <Text style={body}>
        Click the button below to view your revenue, expenses, and statements
        for <strong>{propertyName}</strong>. Your link is valid for 90 days.
      </Text>
    </EmailLayout>
  )
}

export async function renderOwnerPortalEmail(props: Props): Promise<string> {
  return render(<OwnerPortalEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize: 24, fontWeight: 700, color: '#0a1628', margin: '0 0 16px',
}

const body: React.CSSProperties = {
  fontSize: 15, color: '#374151', lineHeight: '1.6', margin: '0 0 14px',
}
