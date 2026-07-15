import { Heading, Text, Row, Column, Hr, Section } from '@react-email/components'
import { render }      from '@react-email/render'
import { EmailLayout } from '@/emails/components/email-layout'

export interface DailyWrapUpTomorrowItem {
  property: string
  time:     string
  crew:     string
}

export interface DailyWrapUpChecklistItem {
  propertyId:   string
  propertyName: string
  openCount:    number
  isNew:        boolean
}

export interface DailyWrapUpAssetHealthItem {
  propertyName: string
  score:        number
}

export interface DailyWrapUpComplianceItem {
  vendorName: string
  docType:    string
  expiryDate: string
  isNew:      boolean
}

export interface DailyWrapUpMaintenance {
  due:        Array<{ name: string; property: string }>
  unassigned: Array<{ woNumber: string; title: string; property: string; suggested: string | null }>
}

export interface DailyWrapUpEscalationItem {
  woNumber: string
  title:    string
  property: string
}

export interface DailyWrapUpVacancyItem {
  propertyName: string
  gapDays:      number
  gapStart:     string
}

export interface DailyWrapUpRepeatIssueItem {
  propertyName: string
  category:     string
  count:        number
}

export interface DailyWrapUpUnassignedTurnoverItem {
  property: string
  checkout: string
}

export interface DailyWrapUpSponsors {
  needed:      boolean
  graceEndsAt: string | null
}

export interface DailyWrapUpInventoryItem {
  property: string
  items:    string[]
}

export interface DailyWrapUpEmailProps {
  tomorrow:            DailyWrapUpTomorrowItem[]
  checklist:           DailyWrapUpChecklistItem[]
  assetHealth:         DailyWrapUpAssetHealthItem[]
  compliance:          DailyWrapUpComplianceItem[]
  maintenance:         DailyWrapUpMaintenance
  escalations:         DailyWrapUpEscalationItem[]
  vacancy:             DailyWrapUpVacancyItem[]
  repeatIssues:        DailyWrapUpRepeatIssueItem[]
  unassignedTurnovers: DailyWrapUpUnassignedTurnoverItem[]
  sponsors:            DailyWrapUpSponsors | null
  inventory:           DailyWrapUpInventoryItem[]
  dashboardUrl:        string
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 15, color: '#0a1628', margin: '0 0 8px', fontWeight: 700,
}

const lineStyle: React.CSSProperties = {
  fontSize: 13, color: '#374151', lineHeight: 1.6, margin: '0 0 4px',
}

const newBadgeStyle: React.CSSProperties = {
  color: '#B8860B', fontWeight: 700,
}

function SectionWrapper({ heading, children }: Readonly<{ heading: string; children: React.ReactNode }>) {
  return (
    <Section style={{ marginBottom: 20 }}>
      <Heading as="h3" style={sectionHeadingStyle}>{heading}</Heading>
      {children}
      <Hr style={{ borderColor: '#e2e8f0', margin: '16px 0 0' }} />
    </Section>
  )
}

function NewTag() {
  return <span style={newBadgeStyle}> · NEW</span>
}

export function DailyWrapUpEmail({
  tomorrow, checklist, assetHealth, compliance, maintenance,
  escalations, vacancy, repeatIssues, unassignedTurnovers, sponsors, inventory,
  dashboardUrl,
}: Readonly<DailyWrapUpEmailProps>) {
  return (
    <EmailLayout
      preview="Your FieldStay daily wrap-up"
      ctaLabel="Open Dashboard →"
      ctaUrl={dashboardUrl}
    >
      <Heading as="h2" style={{ fontSize: 20, color: '#0a1628', margin: '0 0 4px' }}>
        Your daily wrap-up
      </Heading>
      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 24px' }}>
        Here&apos;s what&apos;s worth knowing before tomorrow.
      </Text>

      {tomorrow.length > 0 && (
        <SectionWrapper heading={`Tomorrow's turnovers (${tomorrow.length})`}>
          {tomorrow.map((t, i) => (
            <Text key={i} style={lineStyle}>
              {t.property} — {t.time} — crew: {t.crew}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {checklist.length > 0 && (
        <SectionWrapper heading="Open discovery checklist items">
          {checklist.map((c) => (
            <Text key={c.propertyId} style={lineStyle}>
              {c.propertyName} — {c.openCount} open item{c.openCount !== 1 ? 's' : ''}
              {c.isNew && <NewTag />}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {assetHealth.length > 0 && (
        <SectionWrapper heading="Lowest asset health scores this week">
          {assetHealth.map((a, i) => (
            <Text key={i} style={lineStyle}>
              {a.propertyName} — {a.score}/100
            </Text>
          ))}
        </SectionWrapper>
      )}

      {compliance.length > 0 && (
        <SectionWrapper heading="Vendor compliance docs expiring soon">
          {compliance.map((c, i) => (
            <Text key={i} style={lineStyle}>
              {c.vendorName} — {c.docType.replace(/_/g, ' ')} — expires {new Date(c.expiryDate).toLocaleDateString()}
              {c.isNew && <NewTag />}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {(maintenance.due.length > 0 || maintenance.unassigned.length > 0) && (
        <SectionWrapper heading="Maintenance">
          {maintenance.due.map((d, i) => (
            <Text key={`due-${i}`} style={lineStyle}>
              Due today: {d.name} — {d.property}
            </Text>
          ))}
          {maintenance.unassigned.map((wo, i) => (
            <Text key={`unassigned-${i}`} style={lineStyle}>
              Unassigned WO {wo.woNumber}: {wo.title} — {wo.property}
              {wo.suggested ? ` (suggested: ${wo.suggested})` : ''}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {escalations.length > 0 && (
        <SectionWrapper heading="Escalated to Urgent in the last 24h">
          {escalations.map((e, i) => (
            <Text key={i} style={lineStyle}>
              {e.woNumber}: {e.title} — {e.property}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {vacancy.length > 0 && (
        <SectionWrapper heading="Vacancy gaps in the week ahead">
          {vacancy.map((v, i) => (
            <Text key={i} style={lineStyle}>
              {v.propertyName} — {v.gapDays}-day gap starting {new Date(v.gapStart).toLocaleDateString()}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {repeatIssues.length > 0 && (
        <SectionWrapper heading="Repeat maintenance issues">
          {repeatIssues.map((r, i) => (
            <Text key={i} style={lineStyle}>
              {r.propertyName} — {r.category.replace(/_/g, ' ')} ({r.count}x in 90 days)
            </Text>
          ))}
        </SectionWrapper>
      )}

      {unassignedTurnovers.length > 0 && (
        <SectionWrapper heading="Turnovers still unassigned">
          {unassignedTurnovers.map((t, i) => (
            <Text key={i} style={lineStyle}>
              {t.property} — checkout {new Date(t.checkout).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
            </Text>
          ))}
        </SectionWrapper>
      )}

      {sponsors?.needed && (
        <SectionWrapper heading="Guidebook sponsors needed">
          <Text style={lineStyle}>
            Your guidebook is below the minimum sponsor count. Grace period ends{' '}
            {sponsors.graceEndsAt ? new Date(sponsors.graceEndsAt).toLocaleDateString() : 'soon'}.
          </Text>
        </SectionWrapper>
      )}

      {inventory.length > 0 && (
        <SectionWrapper heading="Inventory restock needed today">
          {inventory.map((po, i) => (
            <Text key={i} style={lineStyle}>
              {po.property} — {po.items.join(', ')}
            </Text>
          ))}
        </SectionWrapper>
      )}

      <Row>
        <Column>
          <Text style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
            Sections with nothing to report are skipped.
          </Text>
        </Column>
      </Row>
    </EmailLayout>
  )
}

export async function renderDailyWrapUpEmail(props: DailyWrapUpEmailProps): Promise<string> {
  return render(<DailyWrapUpEmail {...props} />)
}
