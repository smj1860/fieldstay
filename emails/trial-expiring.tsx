import { Text, Section } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  firstName:         string
  orgName:           string
  trialEndDate:      string
  propertyCount:     number
  ownerRezConnected: boolean
  subscribeUrl:      string
}

export function TrialExpiringEmail({
  firstName,
  orgName,
  trialEndDate,
  propertyCount,
  ownerRezConnected,
  subscribeUrl,
}: Props) {
  return (
    <EmailLayout
      preview={`Your FieldStay trial ends on ${trialEndDate}. Keep everything running.`}
      ctaLabel="Subscribe now →"
      ctaUrl={subscribeUrl}
      footerNote={`You're receiving this because you have an active FieldStay trial for ${orgName}.`}
    >
      <Text style={eyebrow}>YOUR TRIAL ENDS IN 3 DAYS</Text>
      <Text style={heading}>
        Keep your operations running, {firstName}.
      </Text>

      <Text style={body}>
        Your FieldStay trial ends on <strong>{trialEndDate}</strong>.
      </Text>

      {ownerRezConnected && propertyCount > 0 ? (
        <Section style={highlightBox}>
          <Text style={highlightText}>
            You have <strong>{propertyCount} {propertyCount === 1 ? 'property' : 'properties'}</strong> syncing
            from OwnerRez and your turnovers are running. Subscribe to keep
            everything working without interruption.
          </Text>
        </Section>
      ) : (
        <Section style={highlightBox}>
          <Text style={highlightText}>
            If you haven&apos;t had a chance to connect OwnerRez yet, now is
            the right time. Subscribe and connect to see FieldStay at
            full value for your operation.
          </Text>
        </Section>
      )}

      <Text style={body}>
        After your trial ends your account pauses — your data is held
        for 30 days, so nothing is lost if you come back. But your crew
        will lose access and turnovers will stop generating.
      </Text>

      <Text style={body}>
        Questions about plans or pricing? Just reply to this email.
      </Text>

      <Text style={signature}>— Stephen</Text>
    </EmailLayout>
  )
}

export async function renderTrialExpiringEmail(props: Props): Promise<string> {
  return render(<TrialExpiringEmail {...props} />)
}

const eyebrow: React.CSSProperties = {
  fontSize:      11,
  fontWeight:    700,
  color:         '#f59e0b',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin:        '0 0 8px',
}

const heading: React.CSSProperties = {
  fontSize:   24,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 20px',
  lineHeight: '1.2',
}

const body: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 16px',
}

const highlightBox: React.CSSProperties = {
  backgroundColor: '#fefce8',
  border:          '1px solid #fde68a',
  borderRadius:    10,
  padding:         '16px 20px',
  margin:          '0 0 20px',
}

const highlightText: React.CSSProperties = {
  fontSize:   14,
  color:      '#92400e',
  margin:     0,
  lineHeight: '1.6',
}

const signature: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  margin:     '24px 0 0',
  fontWeight: 500,
}
