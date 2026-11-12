import { Heading, Text, Row, Column, Hr, Section, Link } from '@react-email/components'
import { render }      from '@react-email/render'
import { EmailLayout } from '@/emails/components/email-layout'
import { plural, type Capped, type GroupedRow } from '@/lib/wrapup/presentation'

// Every list in this email arrives already capped, grouped and linked by
// lib/wrapup/presentation.ts. The template only draws what it is given; it
// never decides what to leave out.

export interface DailyWrapUpTomorrowItem {
  property:  string
  time:      string
  crew:      string
  needsCrew: boolean
  sameDay:   boolean
  href:      string
}

export interface DailyWrapUpArrivalItem {
  property: string
}

export interface DailyWrapUpTomorrow {
  turnovers: Capped<DailyWrapUpTomorrowItem>
  arrivals:  Capped<DailyWrapUpArrivalItem>
}

export interface DailyWrapUpFreezeItem {
  title: string
  href:  string
}

export type DailyWrapUpChecklistGroup = GroupedRow & { openCount: number }

export interface DailyWrapUpAssetHealthItem {
  propertyName: string
  score:        number
}

export interface DailyWrapUpComplianceItem {
  vendorName: string
  docType:    string
  expiryDate: string
  isNew:      boolean
  href:       string
}

export interface DailyWrapUpUnassignedWorkOrder {
  woNumber:  string
  title:     string
  property:  string
  suggested: string | null
  href:      string
}

export interface DailyWrapUpMaintenance {
  due:        Capped<GroupedRow>
  unassigned: Capped<DailyWrapUpUnassignedWorkOrder>
}

export interface DailyWrapUpEscalationItem {
  woNumber: string
  title:    string
  property: string
  href:     string
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
  href:     string
}

export interface DailyWrapUpSponsors {
  needed:      boolean
  graceEndsAt: string | null
}

export interface DailyWrapUpInventoryItem {
  property: string
  items:    string[]
}

export interface DailyWrapUpDoneToday {
  turnovers:  number
  workOrders: number
}

/** Where each section's "and N more" sends the reader. */
export interface DailyWrapUpLinks {
  bookings:    string
  maintenance: string
  turnovers:   string
  properties:  string
  inventory:   string
  vendors:     string
  assets:      string
}

export interface DailyWrapUpEmailProps {
  summary:             string
  tomorrow:            DailyWrapUpTomorrow
  freeze:              Capped<DailyWrapUpFreezeItem>
  doneToday:           DailyWrapUpDoneToday | null
  checklist:           Capped<DailyWrapUpChecklistGroup>
  assetHealth:         Capped<DailyWrapUpAssetHealthItem>
  compliance:          Capped<DailyWrapUpComplianceItem>
  maintenance:         DailyWrapUpMaintenance
  escalations:         Capped<DailyWrapUpEscalationItem>
  vacancy:             Capped<DailyWrapUpVacancyItem>
  repeatIssues:        Capped<DailyWrapUpRepeatIssueItem>
  unassignedTurnovers: Capped<DailyWrapUpUnassignedTurnoverItem>
  sponsors:            DailyWrapUpSponsors | null
  inventory:           Capped<DailyWrapUpInventoryItem>
  dashboardUrl:        string
  links:               DailyWrapUpLinks
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 15, color: '#0a1628', margin: '0 0 8px', fontWeight: 700,
}

const lineStyle: React.CSSProperties = {
  fontSize: 13, color: '#374151', lineHeight: 1.6, margin: '0 0 4px',
}

const linkStyle: React.CSSProperties = {
  color: '#0a1628', textDecoration: 'underline', fontWeight: 600,
}

const newBadgeStyle: React.CSSProperties = {
  color: '#B8860B', fontWeight: 700,
}

const flagStyle: React.CSSProperties = {
  color: '#B45309', fontWeight: 700,
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

/** A label that links to the thing it names. */
function Linked({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) {
  return <Link href={href} style={linkStyle}>{children}</Link>
}

/** "and 12 more", linking to the page that has all of them. Nothing when the list was not cut. */
function More({ count, href }: Readonly<{ count: number; href: string }>) {
  if (count <= 0) return null
  return (
    <Text style={lineStyle}>
      <Linked href={href}>and {count} more</Linked>
    </Text>
  )
}

/** Total rows in a capped list, shown or not. */
function total<T>(list: Capped<T>): number {
  return list.items.length + list.more
}

/** "Alpine Retreat, Husky Hill and 3 more". */
function nameList(names: readonly string[], more: number): string {
  const shown = names.join(', ')
  return more > 0 ? `${shown} and ${more} more` : shown
}

/** One row of a grouped section: the repeating label, and who it applies to. */
function groupedText(row: GroupedRow): string {
  if (row.count === 1) return `${row.label}, ${row.properties[0]}`
  return `${row.label} at ${row.count} properties (${nameList(row.properties, row.more)})`
}

function TomorrowSection({ tomorrow, links }: Readonly<{ tomorrow: DailyWrapUpTomorrow; links: DailyWrapUpLinks }>) {
  const { turnovers, arrivals } = tomorrow
  if (turnovers.items.length === 0 && arrivals.items.length === 0) return null
  return (
    <SectionWrapper heading="Tomorrow">
      {turnovers.items.map((t, i) => (
        <Text key={i} style={lineStyle}>
          <Linked href={t.href}>{t.property}</Linked>, checkout {t.time}
          {t.sameDay && <span style={flagStyle}> · same-day flip</span>}
          {', '}
          {t.needsCrew ? <span style={flagStyle}>needs a crew</span> : `crew: ${t.crew}`}
        </Text>
      ))}
      <More count={turnovers.more} href={links.turnovers} />
      {arrivals.items.length > 0 && (
        <Text style={lineStyle}>
          Check-ins ({total(arrivals)}): {nameList(arrivals.items.map((a) => a.property), arrivals.more)}
        </Text>
      )}
    </SectionWrapper>
  )
}

function FreezeSection({ freeze, links }: Readonly<{ freeze: Capped<DailyWrapUpFreezeItem>; links: DailyWrapUpLinks }>) {
  if (freeze.items.length === 0) return null
  return (
    <SectionWrapper heading={`Freeze prep tonight (${total(freeze)})`}>
      {freeze.items.map((f, i) => (
        <Text key={i} style={lineStyle}><Linked href={f.href}>{f.title}</Linked></Text>
      ))}
      <More count={freeze.more} href={links.maintenance} />
    </SectionWrapper>
  )
}

function UnassignedTurnoversSection(
  { list, links }: Readonly<{ list: Capped<DailyWrapUpUnassignedTurnoverItem>; links: DailyWrapUpLinks }>,
) {
  if (list.items.length === 0) return null
  return (
    <SectionWrapper heading={`Turnovers still unassigned (${total(list)})`}>
      {list.items.map((t, i) => (
        <Text key={i} style={lineStyle}>
          <Linked href={t.href}>{t.property}</Linked>, checkout {new Date(t.checkout).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
          })}
        </Text>
      ))}
      <More count={list.more} href={links.turnovers} />
    </SectionWrapper>
  )
}

function EscalationsSection(
  { list, links }: Readonly<{ list: Capped<DailyWrapUpEscalationItem>; links: DailyWrapUpLinks }>,
) {
  if (list.items.length === 0) return null
  return (
    <SectionWrapper heading="Escalated to Urgent in the last 24h">
      {list.items.map((e, i) => (
        <Text key={i} style={lineStyle}>
          <Linked href={e.href}>{e.woNumber ? `${e.woNumber}: ${e.title}` : e.title}</Linked>, {e.property}
        </Text>
      ))}
      <More count={list.more} href={links.maintenance} />
    </SectionWrapper>
  )
}

function MaintenanceSection(
  { maintenance, links }: Readonly<{ maintenance: DailyWrapUpMaintenance; links: DailyWrapUpLinks }>,
) {
  const { due, unassigned } = maintenance
  if (due.items.length === 0 && unassigned.items.length === 0) return null
  return (
    <SectionWrapper heading="Maintenance">
      {unassigned.items.map((wo, i) => (
        <Text key={`unassigned-${i}`} style={lineStyle}>
          Unassigned: <Linked href={wo.href}>{wo.woNumber ? `${wo.woNumber} ${wo.title}` : wo.title}</Linked>, {wo.property}
          {wo.suggested ? ` (suggested: ${wo.suggested})` : ''}
        </Text>
      ))}
      <More count={unassigned.more} href={links.maintenance} />
      {due.items.map((d, i) => (
        <Text key={`due-${i}`} style={lineStyle}>Due today: {groupedText(d)}</Text>
      ))}
      <More count={due.more} href={links.maintenance} />
    </SectionWrapper>
  )
}

function InventorySection(
  { list, links }: Readonly<{ list: Capped<DailyWrapUpInventoryItem>; links: DailyWrapUpLinks }>,
) {
  if (list.items.length === 0) return null
  return (
    <SectionWrapper heading="Inventory restock needed today">
      {list.items.map((po, i) => (
        <Text key={i} style={lineStyle}>{po.property}, {po.items.join(', ')}</Text>
      ))}
      <More count={list.more} href={links.inventory} />
    </SectionWrapper>
  )
}

function ComplianceSection(
  { list, links }: Readonly<{ list: Capped<DailyWrapUpComplianceItem>; links: DailyWrapUpLinks }>,
) {
  if (list.items.length === 0) return null
  return (
    <SectionWrapper heading="Vendor compliance docs expiring soon">
      {list.items.map((c, i) => (
        <Text key={i} style={lineStyle}>
          <Linked href={c.href}>{c.vendorName}</Linked>, {c.docType.replace(/_/g, ' ')}, expires {new Date(c.expiryDate).toLocaleDateString()}
          {c.isNew && <NewTag />}
        </Text>
      ))}
      <More count={list.more} href={links.vendors} />
    </SectionWrapper>
  )
}

function ChecklistSection(
  { list, links }: Readonly<{ list: Capped<DailyWrapUpChecklistGroup>; links: DailyWrapUpLinks }>,
) {
  if (list.items.length === 0) return null
  return (
    <SectionWrapper heading="Open discovery checklist items">
      {list.items.map((c, i) => (
        <Text key={i} style={lineStyle}>
          {nameList(c.properties, c.more)}, {plural(c.openCount, 'open item')}
          {c.count > 1 ? ' each' : ''}
          {c.isNew && <NewTag />}
        </Text>
      ))}
      <More count={list.more} href={links.properties} />
    </SectionWrapper>
  )
}

function WatchSections({ props }: Readonly<{ props: DailyWrapUpEmailProps }>) {
  const { repeatIssues, vacancy, assetHealth, sponsors, links } = props
  return (
    <>
      {repeatIssues.items.length > 0 && (
        <SectionWrapper heading="Repeat maintenance issues">
          {repeatIssues.items.map((r, i) => (
            <Text key={i} style={lineStyle}>
              {r.propertyName}, {r.category.replace(/_/g, ' ')} ({r.count}x in 90 days)
            </Text>
          ))}
          <More count={repeatIssues.more} href={links.maintenance} />
        </SectionWrapper>
      )}

      {vacancy.items.length > 0 && (
        <SectionWrapper heading="Vacancy gaps in the week ahead">
          {vacancy.items.map((v, i) => (
            <Text key={i} style={lineStyle}>
              {v.propertyName}, {v.gapDays}-day gap starting {new Date(v.gapStart).toLocaleDateString()}
            </Text>
          ))}
          <More count={vacancy.more} href={links.bookings} />
        </SectionWrapper>
      )}

      {assetHealth.items.length > 0 && (
        <SectionWrapper heading="Lowest asset health scores this week">
          {assetHealth.items.map((a, i) => (
            <Text key={i} style={lineStyle}>{a.propertyName}, {a.score}/100</Text>
          ))}
          <More count={assetHealth.more} href={links.assets} />
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
    </>
  )
}

function DoneTodayLine({ done }: Readonly<{ done: DailyWrapUpDoneToday | null }>) {
  if (!done) return null
  const parts: string[] = []
  if (done.turnovers > 0)  parts.push(`${plural(done.turnovers, 'turnover')} completed`)
  if (done.workOrders > 0) parts.push(`${plural(done.workOrders, 'work order')} closed`)
  return (
    <Text style={{ ...lineStyle, margin: '0 0 12px' }}>
      <strong>Done today:</strong> {parts.join(', ')}.
    </Text>
  )
}

export function DailyWrapUpEmail(props: Readonly<DailyWrapUpEmailProps>) {
  const { summary, tomorrow, freeze, checklist, compliance, maintenance, escalations,
    unassignedTurnovers, inventory, doneToday, links, dashboardUrl } = props
  return (
    <EmailLayout
      preview={summary}
      ctaLabel="Open Dashboard →"
      ctaUrl={dashboardUrl}
    >
      <Heading as="h2" style={{ fontSize: 20, color: '#0a1628', margin: '0 0 4px' }}>
        Your daily wrap-up
      </Heading>
      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 24px' }}>
        {summary}
      </Text>

      <TomorrowSection tomorrow={tomorrow} links={links} />
      <FreezeSection freeze={freeze} links={links} />
      <UnassignedTurnoversSection list={unassignedTurnovers} links={links} />
      <EscalationsSection list={escalations} links={links} />
      <MaintenanceSection maintenance={maintenance} links={links} />
      <InventorySection list={inventory} links={links} />
      <ComplianceSection list={compliance} links={links} />
      <WatchSections props={props} />
      <ChecklistSection list={checklist} links={links} />

      <DoneTodayLine done={doneToday} />

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
