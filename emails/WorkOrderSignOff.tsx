import {
  Body, Container, Head, Hr,
  Html, Preview, Section, Text
} from '@react-email/components'

interface WorkOrderSignOffEmailProps {
  woNumber:        string
  title:           string
  propertyName:    string
  propertyAddress: string
  vendorName:      string | null
  signOffNotes:    string | null
  signedOffAt:     string
  pmName:          string
}

const ORANGE   = '#FF6B00'
const CHARCOAL = '#1A1A1A'
const CHROME   = '#C0C0C0'

export default function WorkOrderSignOffEmail({
  woNumber        = 'WO-2025-06-0042',
  title           = 'HVAC Maintenance',
  propertyName    = 'The Riverside Retreat',
  propertyAddress = '1247 Sunrise Blvd, Austin TX 78701',
  vendorName      = 'Mike Johnson',
  signOffNotes    = null,
  signedOffAt     = new Date().toISOString(),
  pmName          = 'Sarah',
}: WorkOrderSignOffEmailProps) {

  const formattedDate = new Date(signedOffAt).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit'
  } as Intl.DateTimeFormatOptions)

  return (
    <Html>
      <Head/>
      <Preview>
        ✓ Work Complete — {woNumber} · {propertyName}
      </Preview>
      <Body style={{ backgroundColor:'#F5F5F5',
                     fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                     margin:0, padding:0 }}>

        <Section style={{ backgroundColor:CHARCOAL, padding:'20px 0' }}>
          <Container style={{ maxWidth:520, margin:'0 auto', padding:'0 24px' }}>
            <Text style={{ color:'#E0E0E0', fontSize:13, fontWeight:900,
                           letterSpacing:'0.07em', margin:0 }}>
              TRADESUITE{' '}
              <span style={{ color:ORANGE }}>PRO</span>
            </Text>
          </Container>
        </Section>
        <Section style={{ backgroundColor:CHROME, height:2, opacity:0.4 }}/>

        <Container style={{ backgroundColor:'#fff', maxWidth:520,
                            margin:'0 auto', padding:'28px 28px 24px' }}>

          <Section style={{ textAlign:'center', paddingBottom:20 }}>
            <Text style={{ fontSize:40, margin:'0 0 8px' }}>✅</Text>
            <Text style={{ color:'#14532D', fontSize:20, fontWeight:800,
                           margin:'0 0 4px' }}>
              Work Order Complete
            </Text>
            <Text style={{ color:'#16A34A', fontSize:12, margin:0 }}>
              {formattedDate}
            </Text>
          </Section>

          <Hr style={{ borderColor:'#EBEBEB', margin:'0 0 20px' }}/>

          <Text style={{ color:'#444', fontSize:14, lineHeight:1.6, margin:'0 0 16px' }}>
            Hi {pmName}, your work order has been signed off
            {vendorName ? ` by ${vendorName}` : ''}.
          </Text>

          {[
            ['Work Order', woNumber],
            ['Job',        title],
            ['Property',   propertyName],
            ['Address',    propertyAddress],
          ].map(([label, value]) => (
            <Section key={label} style={{ marginBottom:8 }}>
              <Text style={{ color:'#999', fontSize:10, fontWeight:700,
                             letterSpacing:'0.12em', textTransform:'uppercase',
                             margin:'0 0 2px' }}>
                {label}
              </Text>
              <Text style={{ color:'#111', fontSize:14, fontWeight:600, margin:0 }}>
                {value}
              </Text>
            </Section>
          ))}

          {signOffNotes && (
            <>
              <Hr style={{ borderColor:'#EBEBEB', margin:'16px 0' }}/>
              <Text style={{ color:'#999', fontSize:10, fontWeight:700,
                             letterSpacing:'0.12em', textTransform:'uppercase',
                             margin:'0 0 6px' }}>
                Contractor Notes
              </Text>
              <Section style={{ backgroundColor:'#F9F9F9', border:'1px solid #EBEBEB',
                                borderRadius:8, padding:'12px 14px' }}>
                <Text style={{ color:'#333', fontSize:13.5, lineHeight:1.6, margin:0 }}>
                  {signOffNotes}
                </Text>
              </Section>
            </>
          )}

        </Container>

        <Section style={{ backgroundColor:CHARCOAL, padding:'18px 0 22px' }}>
          <Container style={{ maxWidth:520, margin:'0 auto',
                              padding:'0 24px', textAlign:'center' }}>
            <Text style={{ color:'#555', fontSize:11, margin:'0 0 4px' }}>
              Powered by <strong style={{ color:'#E0E0E0' }}>TradeSuite Pro</strong>
            </Text>
            <Text style={{ margin:0 }}>
              <a href="https://tradesuite.com"
                 style={{ color:ORANGE, fontSize:11, textDecoration:'none' }}>
                tradesuite.com
              </a>
            </Text>
          </Container>
        </Section>

      </Body>
    </Html>
  )
}
