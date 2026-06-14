import {
  Body, Button, Container, Head, Hr,
  Html, Preview, Row, Column, Section, Text,
} from '@react-email/components'

interface WorkOrderDispatchEmailProps {
  woNumber:        string
  publicUrl:       string
  vendorName:      string
  propertyName:    string
  propertyAddress: string
  title:           string
  description:     string
  nteAmount:       number
  dispatcherName:  string
  dispatcherOrg:   string
  dispatcherPhone: string | null
}

const ORANGE   = '#FF6B00'
const CHARCOAL = '#1A1A1A'
const CHROME   = '#C0C0C0'

export default function WorkOrderDispatchEmail({
  woNumber        = 'WO-2025-06-0042',
  publicUrl       = 'https://app.fieldstay.com/work-orders/abc123',
  vendorName      = 'Contractor',
  propertyName    = 'The Riverside Retreat',
  propertyAddress = '1247 Sunrise Blvd, Austin TX 78701',
  title           = 'HVAC Maintenance',
  description     = 'Annual HVAC filter replacement and coil cleaning.',
  nteAmount       = 350,
  dispatcherName  = 'Sarah Martinez',
  dispatcherOrg   = 'Mountain View Property Management',
  dispatcherPhone = '(512) 847-2930',
}: WorkOrderDispatchEmailProps) {

  const formattedNte = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0
  }).format(nteAmount)

  return (
    <Html>
      <Head/>
      <Preview>
        Work Order {woNumber} — {propertyName} — Authorized up to {formattedNte}
      </Preview>
      <Body style={body}>

        {/* ── Dark header ── */}
        <Section style={header}>
          <Container style={headerInner}>
            <Row>
              <Column>
                <Text style={brandName}>TRADESUITE</Text>
                <Text style={brandPro}>PRO</Text>
              </Column>
              <Column align="right">
                <Text style={woBadge}>Work Order</Text>
                <Text style={woNum}>{woNumber}</Text>
              </Column>
            </Row>
          </Container>
        </Section>

        <Section style={chromeDivider}/>

        <Container style={container}>

          <Section style={{ paddingTop:28 }}>
            <Text style={greeting}>Hi {vendorName},</Text>
            <Text style={bodyText}>
              A work order has been dispatched to you from{' '}
              <strong>{dispatcherOrg}</strong>. Review the details and
              sign off when the work is complete.
            </Text>
          </Section>

          <Hr style={divider}/>

          <Section>
            <Text style={sectionLabel}>PROPERTY</Text>
            <Text style={propertyNameStyle}>{propertyName}</Text>
            <Text style={propertyAddr}>{propertyAddress}</Text>
          </Section>

          <Hr style={divider}/>

          <Section>
            <Text style={sectionLabel}>SCOPE OF WORK</Text>
            <Text style={scopeTitle}>{title}</Text>
            {description && (
              <Text style={scopeBody}>{description}</Text>
            )}
          </Section>

          <Hr style={divider}/>

          <Section style={authBox}>
            <Text style={authLabel}>AUTHORIZED UP TO</Text>
            <Text style={authAmount}>{formattedNte}</Text>
            <Text style={authNote}>
              Work exceeding this amount requires PM approval before proceeding.
              Contact {dispatcherName} before starting any additional scope.
            </Text>
          </Section>

          <Section style={{ textAlign:'center', paddingTop:28, paddingBottom:8 }}>
            <Button href={publicUrl} style={ctaButton}>
              View Work Order & Sign Off →
            </Button>
          </Section>

          <Section style={{ textAlign:'center', paddingBottom:28 }}>
            <Text style={ctaNote}>
              This link is for your eyes only. It expires in 30 days.
            </Text>
          </Section>

          <Hr style={divider}/>

          <Section>
            <Text style={sectionLabel}>DISPATCHED BY</Text>
            <Text style={dispatcherNameStyle}>{dispatcherName}</Text>
            <Text style={dispatcherOrgStyle}>{dispatcherOrg}</Text>
            {dispatcherPhone && (
              <Text style={dispatcherPhoneStyle}>
                📞 {dispatcherPhone}
              </Text>
            )}
          </Section>

          <Hr style={divider}/>

          <Section>
            <Text style={accessNote}>
              🔑 Property access details (lockbox code, parking, and site notes)
              are available on the secure work order page — tap the button above to view.
            </Text>
          </Section>

        </Container>

        {/* ── Footer ── */}
        <Section style={footer}>
          <Container style={footerInner}>
            <Text style={footerBrand}>
              TRADESUITE <span style={{ color:ORANGE }}>PRO</span>
            </Text>
            <Text style={footerTagline}>
              Professional work orders & invoicing for skilled trades
            </Text>
            <Text style={footerLink}>
              <a href="https://tradesuite.com" style={{ color:ORANGE, textDecoration:'none' }}>
                Get TradeSuite Pro for your business →
              </a>
            </Text>
            <Hr style={{ borderColor:'#333', marginTop:16 }}/>
            <Text style={footerMeta}>
              This work order was sent via FieldStay property management.
              If you received this in error, please disregard.
            </Text>
          </Container>
        </Section>

      </Body>
    </Html>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────
const body: React.CSSProperties = {
  backgroundColor: '#F5F5F5',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  margin: 0,
  padding: 0,
}
const header: React.CSSProperties = {
  backgroundColor: CHARCOAL,
  padding: '24px 0 20px',
}
const headerInner: React.CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '0 24px',
}
const brandName: React.CSSProperties = {
  color: '#E0E0E0',
  fontSize: 16,
  fontWeight: 900,
  letterSpacing: '0.08em',
  margin: 0,
  lineHeight: 1.1,
}
const brandPro: React.CSSProperties = {
  color: ORANGE,
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: '0.22em',
  margin: '2px 0 0',
}
const woBadge: React.CSSProperties = {
  color: '#666',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  margin: 0,
  lineHeight: 1.1,
}
const woNum: React.CSSProperties = {
  color: '#F0F0F0',
  fontSize: 18,
  fontWeight: 900,
  letterSpacing: '-0.02em',
  margin: '2px 0 0',
}
const chromeDivider: React.CSSProperties = {
  backgroundColor: CHROME,
  height: 2,
  opacity: 0.4,
}
const container: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  maxWidth: 560,
  margin: '0 auto',
  padding: '0 28px',
}
const greeting: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: '#111',
  margin: '0 0 8px',
}
const bodyText: React.CSSProperties = {
  fontSize: 14,
  color: '#555',
  lineHeight: 1.6,
  margin: '0 0 4px',
}
const divider: React.CSSProperties = {
  borderColor: '#EBEBEB',
  margin: '20px 0',
}
const sectionLabel: React.CSSProperties = {
  color: '#999',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  margin: '0 0 6px',
}
const propertyNameStyle: React.CSSProperties = {
  color: '#111',
  fontSize: 17,
  fontWeight: 800,
  margin: '0 0 2px',
  letterSpacing: '-0.01em',
}
const propertyAddr: React.CSSProperties = {
  color: '#666',
  fontSize: 13,
  margin: 0,
}
const scopeTitle: React.CSSProperties = {
  color: '#111',
  fontSize: 15,
  fontWeight: 700,
  margin: '0 0 6px',
}
const scopeBody: React.CSSProperties = {
  color: '#444',
  fontSize: 13.5,
  lineHeight: 1.6,
  margin: 0,
}
const authBox: React.CSSProperties = {
  backgroundColor: '#FFF4EE',
  border: `2px solid ${ORANGE}`,
  borderRadius: 12,
  padding: '20px 22px',
}
const authLabel: React.CSSProperties = {
  color: '#CC4A00',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  margin: '0 0 4px',
}
const authAmount: React.CSSProperties = {
  color: ORANGE,
  fontSize: 52,
  fontWeight: 900,
  letterSpacing: '-0.04em',
  lineHeight: 1,
  margin: '0 0 10px',
}
const authNote: React.CSSProperties = {
  color: '#CC4A00',
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
}
const ctaButton: React.CSSProperties = {
  backgroundColor: CHARCOAL,
  color: '#F0F0F0',
  fontSize: 15,
  fontWeight: 800,
  letterSpacing: '0.01em',
  padding: '16px 32px',
  borderRadius: 12,
  border: `2px solid ${ORANGE}`,
  textDecoration: 'none',
  display: 'inline-block',
}
const ctaNote: React.CSSProperties = {
  color: '#AAA',
  fontSize: 11,
  margin: '8px 0 0',
}
const dispatcherNameStyle: React.CSSProperties = {
  color: '#111',
  fontSize: 14,
  fontWeight: 700,
  margin: '0 0 2px',
}
const dispatcherOrgStyle: React.CSSProperties = {
  color: '#666',
  fontSize: 12,
  margin: '0 0 2px',
}
const dispatcherPhoneStyle: React.CSSProperties = {
  color: '#666',
  fontSize: 12,
  margin: 0,
}
const accessNote: React.CSSProperties = {
  color: '#555',
  fontSize: 13,
  lineHeight: 1.6,
  backgroundColor: '#F9F9F9',
  border: '1px solid #EBEBEB',
  borderRadius: 8,
  padding: '12px 14px',
  margin: 0,
}
const footer: React.CSSProperties = {
  backgroundColor: CHARCOAL,
  padding: '24px 0 28px',
  marginTop: 0,
}
const footerInner: React.CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '0 24px',
  textAlign: 'center',
}
const footerBrand: React.CSSProperties = {
  color: '#E0E0E0',
  fontSize: 13,
  fontWeight: 900,
  letterSpacing: '0.07em',
  margin: '0 0 4px',
}
const footerTagline: React.CSSProperties = {
  color: '#555',
  fontSize: 11,
  margin: '0 0 6px',
}
const footerLink: React.CSSProperties = {
  margin: '0 0 0',
  fontSize: 11,
}
const footerMeta: React.CSSProperties = {
  color: '#444',
  fontSize: 10,
  lineHeight: 1.5,
  margin: '12px 0 0',
}
