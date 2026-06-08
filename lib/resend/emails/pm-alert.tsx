import { Heading, Text, Button, Row, Column, Hr, Section } from '@react-email/components'
import { render } from '@react-email/render'
import { BaseLayout } from './base-layout'

export interface PmAlertTable {
  headers: string[]
  rows:    string[][]
}

export interface PmAlertProps {
  heading:  string
  body:     string
  details?: Array<{ label: string; value: string | null | undefined }>
  table?:   PmAlertTable
  note?:    string
  ctaLabel: string
  ctaUrl:   string
}

/**
 * Generic PM-facing alert — replaces the raw-HTML buildScheduleEmail()
 * template string and inline `html: \`<div...\`` sends scattered across
 * the Inngest notification functions.
 */
export function PmAlert({ heading, body, details, table, note, ctaLabel, ctaUrl }: PmAlertProps) {
  const rows = details?.filter((d) => d.value != null && d.value !== '') ?? []

  return (
    <BaseLayout previewText={heading}>
      <Heading as="h2" style={{ fontSize: 20, color: '#0f172a', margin: '0 0 12px' }}>
        {heading}
      </Heading>
      <Text style={{ fontSize: 14, color: '#334155', lineHeight: 1.6, margin: '0 0 20px' }}>
        {body}
      </Text>

      {rows.length > 0 && (
        <>
          <Section style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: '14px 16px' }}>
            {rows.map((d) => (
              <Row key={d.label} style={{ marginBottom: 8 }}>
                <Column style={{ color: '#64748b', fontSize: 13, width: '140px' }}>{d.label}</Column>
                <Column style={{ color: '#0f172a', fontSize: 13, fontWeight: 600 }}>{d.value}</Column>
              </Row>
            ))}
          </Section>
          <Hr style={{ borderColor: '#e2e8f0', margin: '16px 0 24px' }} />
        </>
      )}

      {table && (
        <Section style={{ marginBottom: 20 }}>
          <Row style={{ backgroundColor: '#f1f5f9' }}>
            {table.headers.map((h, i) => (
              <Column
                key={i}
                style={{
                  padding: '10px 8px',
                  fontSize: 12,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  textAlign: i === 0 ? 'left' : 'center',
                }}
              >
                {h}
              </Column>
            ))}
          </Row>
          {table.rows.map((r, ri) => (
            <Row key={ri} style={{ borderBottom: '1px solid #e2e8f0' }}>
              {r.map((cell, ci) => (
                <Column
                  key={ci}
                  style={{
                    padding: '8px',
                    fontSize: 13,
                    color: ci === 0 ? '#1e293b' : '#0f172a',
                    fontWeight: ci === 0 ? 400 : 600,
                    textAlign: ci === 0 ? 'left' : 'center',
                  }}
                >
                  {cell}
                </Column>
              ))}
            </Row>
          ))}
        </Section>
      )}

      {note && (
        <Text style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px' }}>
          {note}
        </Text>
      )}

      <Button
        href={ctaUrl}
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
        {ctaLabel}
      </Button>
    </BaseLayout>
  )
}

export async function renderPmAlert(props: PmAlertProps): Promise<string> {
  return render(<PmAlert {...props} />)
}
