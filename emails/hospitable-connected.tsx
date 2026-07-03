// emails/hospitable-connected.tsx

import { Text, Section } from '@react-email/components'
import { render }         from '@react-email/render'
import { EmailLayout }    from './components/email-layout'

interface Props {
  firstName:    string
  orgName:      string
  dashboardUrl: string
}

export function HospitableConnectedEmail({ firstName, orgName, dashboardUrl }: Props) {
  return (
    <EmailLayout
      preview="Hospitable connected — your properties are syncing now."
      ctaLabel="View your properties →"
      ctaUrl={dashboardUrl}
      footerNote={`You're receiving this because you connected Hospitable to your FieldStay account for ${orgName}.`}
    >
      <Text style={heading}>Hospitable connected.</Text>
      <Text style={body}>
        Hi {firstName} — your Hospitable account is connected and your properties
        and upcoming bookings are syncing now. This typically completes within
        3–5 minutes.
      </Text>

      <Text style={sectionLabel}>WHAT HAPPENS NEXT</Text>

      <Section style={infoRow}>
        <Text style={infoItem}>✦ Turnovers generate automatically after each checkout</Text>
      </Section>
      <Section style={infoRow}>
        <Text style={infoItem}>✦ Booking changes sync automatically via webhooks</Text>
      </Section>
      <Section style={{ ...infoRow, marginBottom: 28 }}>
        <Text style={infoItem}>✦ Your turnover board will start populating within minutes</Text>
      </Section>

      <Text style={body}>
        While the sync runs, it&apos;s a good time to add your crew members and
        set up turnover checklists so turnovers are ready to assign the moment
        they appear.
      </Text>

      <Text style={body}>
        If properties haven&apos;t appeared after 10 minutes, go to
        Settings → Integrations and reconnect. If it&apos;s still not working,
        just reply to this email.
      </Text>

      <Text style={signature}>— Stephen &amp; the FieldStay team</Text>
    </EmailLayout>
  )
}

export async function renderHospitableConnectedEmail(props: Props): Promise<string> {
  return render(<HospitableConnectedEmail {...props} />)
}

const heading: React.CSSProperties = {
  fontSize: 26, fontWeight: 700, color: '#0a1628', margin: '0 0 16px',
}
const body: React.CSSProperties = {
  fontSize: 15, color: '#374151', lineHeight: '1.6', margin: '0 0 16px',
}
const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#94a3b8',
  letterSpacing: '0.1em', textTransform: 'uppercase', margin: '8px 0 12px',
}
const infoRow: React.CSSProperties  = { marginBottom: 6 }
const infoItem: React.CSSProperties = { fontSize: 14, color: '#374151', margin: 0, lineHeight: '1.5' }
const signature: React.CSSProperties = { fontSize: 15, color: '#374151', margin: '24px 0 0', fontWeight: 500 }
