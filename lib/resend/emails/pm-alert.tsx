import { Fragment } from 'react'
import {
  Heading, Text, Row, Column, Hr, Section,
} from '@react-email/components'
import { render }      from '@react-email/render'
import { EmailLayout } from '@/emails/components/email-layout'

export interface PmAlertTable {
  headers: string[]
  rows:    string[][]
}

export interface PmAlertSection {
  heading: string
  table:   PmAlertTable
}

export interface PmAlertProps {
  heading:   string
  body:      string
  details?:  Array<{ label: string; value: string | null | undefined }>
  table?:    PmAlertTable
  sections?: PmAlertSection[]
  note?:     string
  ctaLabel:  string
  ctaUrl:    string
}

function TableBlock({ table }: Readonly<{ table: PmAlertTable }>) {
  return (
    <Section style={{ marginBottom: 20 }}>
      <Row style={{ backgroundColor: '#f1f5f9' }}>
        {table.headers.map((h, i) => (
          <Column
            key={i}
            style={{
              padding: '10px 8px', fontSize: 12, color: '#64748b',
              textTransform: 'uppercase', textAlign: i === 0 ? 'left' : 'center',
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
                padding: '8px', fontSize: 13,
                color: ci === 0 ? '#1e293b' : '#0a1628',
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
  )
}

export function PmAlert({
  heading, body, details, table, sections, note, ctaLabel, ctaUrl,
}: PmAlertProps) {
  const rows = details?.filter((d) => d.value !== null && d.value !== '') ?? []

  return (
    <EmailLayout
      preview={heading}
      ctaLabel={ctaLabel}
      ctaUrl={ctaUrl}
    >
      <Heading
        as="h2"
        style={{ fontSize: 20, color: '#0a1628', margin: '0 0 12px' }}
      >
        {heading}
      </Heading>

      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 20px' }}>
        {body}
      </Text>

      {rows.length > 0 && (
        <>
          <Section style={{ backgroundColor: '#f8fafc', borderRadius: 8, padding: '14px 16px' }}>
            {rows.map((d) => (
              <Row key={d.label} style={{ marginBottom: 8 }}>
                <Column style={{ color: '#64748b', fontSize: 13, width: '140px' }}>
                  {d.label}
                </Column>
                <Column style={{ color: '#0a1628', fontSize: 13, fontWeight: 600 }}>
                  {d.value}
                </Column>
              </Row>
            ))}
          </Section>
          <Hr style={{ borderColor: '#e2e8f0', margin: '16px 0 24px' }} />
        </>
      )}

      {table && <TableBlock table={table} />}

      {sections?.map((s) => (
        <div key={s.heading}>
          <Heading as="h3" style={{ fontSize: 15, color: '#0a1628', margin: '0 0 8px' }}>
            {s.heading}
          </Heading>
          <TableBlock table={s.table} />
        </div>
      ))}

      {note && (
        <Text style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px' }}>
          {note.split('\n').map((line, i, arr) => (
            <Fragment key={i}>
              {line}
              {i < arr.length - 1 && <br />}
            </Fragment>
          ))}
        </Text>
      )}
    </EmailLayout>
  )
}

export async function renderPmAlert(props: PmAlertProps): Promise<string> {
  return render(<PmAlert {...props} />)
}
