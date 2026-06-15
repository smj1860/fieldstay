import { Text, Section, Row, Column } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  vendorName:      string
  jobTitle:        string
  description?:    string
  scheduledDate?:  string
  propertyName:    string
  propertyCity?:   string
  propertyState?:  string
  portalUrl:       string
}

export function WorkOrderEmail({
  vendorName,
  jobTitle,
  description,
  scheduledDate,
  propertyName,
  propertyCity,
  propertyState,
  portalUrl,
}: Props) {
  const propertyLocation = [propertyCity, propertyState].filter(Boolean).join(', ')

  return (
    <EmailLayout
      preview={`Work order: ${jobTitle} at ${propertyName}`}
      ctaLabel="View work order →"
      ctaUrl={portalUrl}
      footerNote="This link expires in 30 days. Reply to this email if you have questions."
    >
      <Text style={heading}>Work Order</Text>
      <Text style={body}>
        Hi {vendorName} — you&apos;ve been assigned a work order at{' '}
        <strong>{propertyName}</strong>.
      </Text>

      <Section style={detailsBox}>
        <Row style={detailRow}>
          <Column style={detailLabel}>Job</Column>
          <Column style={detailValue}>{jobTitle}</Column>
        </Row>
        {description && (
          <Row style={detailRow}>
            <Column style={detailLabel}>Details</Column>
            <Column style={detailValue}>{description}</Column>
          </Row>
        )}
        {scheduledDate && (
          <Row style={detailRow}>
            <Column style={detailLabel}>Scheduled</Column>
            <Column style={{ ...detailValue, fontWeight: 700 }}>{scheduledDate}</Column>
          </Row>
        )}
        <Row style={detailRow}>
          <Column style={detailLabel}>Property</Column>
          <Column style={detailValue}>
            {propertyName}{propertyLocation ? ` · ${propertyLocation}` : ''}
          </Column>
        </Row>
      </Section>

      <Text style={body}>
        Use the button below to view the full work order details and
        confirm completion when the job is done.
      </Text>
    </EmailLayout>
  )
}

export async function renderWorkOrderEmail(props: Props): Promise<string> {
  return render(<WorkOrderEmail {...props} />)
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
  margin:     '0 0 16px',
}

const detailsBox: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  border:          '1px solid #e2e8f0',
  borderRadius:    10,
  padding:         '4px 20px',
  margin:          '0 0 24px',
}

const detailRow: React.CSSProperties = {
  borderBottom: '1px solid #e2e8f0',
  padding:      '10px 0',
}

const detailLabel: React.CSSProperties = {
  fontSize:      13,
  color:         '#94a3b8',
  width:         90,
  verticalAlign: 'top',
}

const detailValue: React.CSSProperties = {
  fontSize: 13,
  color:    '#374151',
}
