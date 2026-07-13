import { Text } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  orgName:          string
  activeSponsors:   number
  gracePeriodEndsAt: string
  guidebookUrl:     string
}

export function GuidebookGracePeriodEmail({
  orgName,
  activeSponsors,
  gracePeriodEndsAt,
  guidebookUrl,
}: Props) {
  const deadline = new Date(gracePeriodEndsAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })

  return (
    <EmailLayout
      preview={`Your guidebook needs sponsors by ${deadline}`}
      ctaLabel="Manage Sponsors →"
      ctaUrl={guidebookUrl}
      footerNote="Your guests will see a 'coming soon' placeholder if the guidebook locks."
    >
      <Text style={heading}>Your Guidebook Is at Risk</Text>
      <Text style={body}>
        {orgName} currently has <strong>{activeSponsors} of 4</strong>{' '}active
        sponsors needed to keep your free digital guidebook running.
      </Text>
      <Text style={body}>
        You have until <strong>{deadline}</strong>{' '}to add more sponsors before
        the guidebook locks for your guests. Add sponsors now to keep it active
        at no cost to you.
      </Text>
    </EmailLayout>
  )
}

export async function renderGuidebookGracePeriodEmail(props: Props): Promise<string> {
  return render(<GuidebookGracePeriodEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize: 24, fontWeight: 700, color: '#0a1628', margin: '0 0 16px',
}

const body: React.CSSProperties = {
  fontSize: 15, color: '#374151', lineHeight: '1.6', margin: '0 0 14px',
}
