import {
  Html, Head, Body, Container, Section, Row, Column,
  Text, Button, Hr, Preview,
} from '@react-email/components'
import { render } from '@react-email/render'

export interface WorkOrderEmailProps {
  wo_number:        string | null
  title:            string
  description:      string | null
  wo_category:      string | null
  priority_level:   string | null
  scheduled_date:   string | null
  nte_amount:       number | null
  property_name:    string
  address_line1:    string | null
  city:             string | null
  state:            string | null
  zip:              string | null
  portal_url:       string
  portal_type:      'complete' | 'quote'
  pm_name?:         string | null
  expires_in_days:  number
}

const CATEGORY_LABELS: Record<string, string> = {
  hvac:          'HVAC',
  plumbing:      'Plumbing',
  electrical:    'Electrical',
  appliance:     'Appliance',
  cleaning:      'Cleaning',
  landscaping:   'Landscaping',
  roofing:       'Roofing',
  flooring:      'Flooring',
  windows_doors: 'Windows & Doors',
  pest_control:  'Pest Control',
  pool:          'Pool / Spa',
  structural:    'Structural',
  general:       'General Maintenance',
  other:         'Other',
}

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  low:    { bg: '#f1f5f9', text: '#64748b' },
  medium: { bg: '#dbeafe', text: '#1d4ed8' },
  high:   { bg: '#fef3c7', text: '#b45309' },
  urgent: { bg: '#fee2e2', text: '#b91c1c' },
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'To be confirmed'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

export function WorkOrderVendorEmail({
  wo_number,
  title,
  description,
  wo_category,
  priority_level,
  scheduled_date,
  nte_amount,
  property_name,
  address_line1,
  city,
  state,
  zip,
  portal_url,
  portal_type,
  pm_name,
  expires_in_days,
}: WorkOrderEmailProps) {
  const categoryLabel = wo_category ? (CATEGORY_LABELS[wo_category] ?? wo_category) : null
  const priorityStyle = priority_level ? (PRIORITY_COLORS[priority_level] ?? PRIORITY_COLORS.low) : null
  const priorityLabel = priority_level
    ? priority_level.charAt(0).toUpperCase() + priority_level.slice(1)
    : null

  const addressLine2 = [city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '')
  const fullAddress  = address_line1
    ? `${address_line1}, ${addressLine2}`
    : addressLine2 || null

  const previewText = wo_number
    ? `WO-${wo_number}: ${title} at ${property_name}`
    : `Work order: ${title} at ${property_name}`

  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={{ backgroundColor: '#f1f5f9', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: 600, margin: '32px auto', padding: 0 }}>

          {/* ── Header ── */}
          <Section style={{ backgroundColor: '#0a1628', borderRadius: '12px 12px 0 0', padding: '28px 32px' }}>
            <Text style={{ color: '#FCD116', fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', margin: 0, lineHeight: 1 }}>
              FieldStay
            </Text>
            <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', margin: '6px 0 0' }}>
              Work Order
            </Text>
            {wo_number && (
              <Text style={{ color: '#FCD116', fontSize: 28, fontWeight: 800, margin: '12px 0 0', letterSpacing: '-0.5px' }}>
                WO-{wo_number}
              </Text>
            )}
          </Section>

          {/* ── Body card ── */}
          <Section style={{ backgroundColor: '#ffffff', padding: '28px 32px' }}>

            {/* Property block */}
            <Section style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: '14px 16px', marginBottom: 24, borderLeft: '3px solid #FCD116' }}>
              <Text style={{ fontSize: 15, fontWeight: 700, color: '#0a1628', margin: 0 }}>
                {property_name}
              </Text>
              {fullAddress && (
                <Text style={{ fontSize: 13, color: '#475569', margin: '4px 0 0' }}>
                  {fullAddress}
                </Text>
              )}
            </Section>

            {/* Job title */}
            <Text style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 20px' }}>
              {title}
            </Text>

            {/* Details grid */}
            <Row style={{ marginBottom: 20 }}>
              {categoryLabel && (
                <Column style={{ width: '50%', paddingRight: 8 }}>
                  <Text style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
                    Category
                  </Text>
                  <Text style={{ fontSize: 13, color: '#1e293b', fontWeight: 600, margin: 0 }}>
                    {categoryLabel}
                  </Text>
                </Column>
              )}
              {priorityLabel && priorityStyle && (
                <Column style={{ width: '50%', paddingLeft: 8 }}>
                  <Text style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
                    Priority
                  </Text>
                  <Text style={{
                    display: 'inline-block',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '2px 10px',
                    borderRadius: 99,
                    backgroundColor: priorityStyle.bg,
                    color: priorityStyle.text,
                    margin: 0,
                  }}>
                    {priorityLabel}
                  </Text>
                </Column>
              )}
            </Row>

            <Row style={{ marginBottom: 20 }}>
              <Column style={{ width: '50%', paddingRight: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
                  Scheduled Date
                </Text>
                <Text style={{ fontSize: 13, color: '#1e293b', fontWeight: 600, margin: 0 }}>
                  {formatDate(scheduled_date)}
                </Text>
              </Column>
              {nte_amount != null && (
                <Column style={{ width: '50%', paddingLeft: 8 }}>
                  <Text style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
                    Not to Exceed
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: 800, color: '#0a1628', margin: 0 }}>
                    ${nte_amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </Text>
                </Column>
              )}
            </Row>

            {/* Scope of work */}
            {description && (
              <>
                <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />
                <Text style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
                  Scope of Work
                </Text>
                <Section style={{ backgroundColor: '#f8fafc', borderRadius: 6, padding: '12px 14px', marginBottom: 24 }}>
                  <Text style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>
                    {description}
                  </Text>
                </Section>
              </>
            )}

            <Hr style={{ borderColor: '#e2e8f0', margin: '4px 0 24px' }} />

            {/* CTA */}
            <Button
              href={portal_url}
              style={{
                backgroundColor: '#FCD116',
                color: '#0a1628',
                fontWeight: 700,
                fontSize: 15,
                padding: '14px 32px',
                borderRadius: 8,
                textDecoration: 'none',
                display: 'block',
                textAlign: 'center',
              }}
            >
              {portal_type === 'quote' ? 'Submit Quote →' : 'Mark as Complete →'}
            </Button>
          </Section>

          {/* ── Footer ── */}
          <Section style={{ backgroundColor: '#f8fafc', borderRadius: '0 0 12px 12px', padding: '18px 32px', borderTop: '1px solid #e2e8f0' }}>
            <Text style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 4px' }}>
              This link expires in {expires_in_days} day{expires_in_days !== 1 ? 's' : ''}.
            </Text>
            {pm_name && (
              <Text style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 4px' }}>
                Questions? Reach out to {pm_name}.
              </Text>
            )}
            <Text style={{ fontSize: 11, color: '#cbd5e1', margin: '8px 0 0' }}>
              Powered by FieldStay · fieldstay.app
            </Text>
          </Section>

        </Container>
      </Body>
    </Html>
  )
}

export async function renderWorkOrderVendorEmail(props: WorkOrderEmailProps): Promise<string> {
  return render(<WorkOrderVendorEmail {...props} />)
}
