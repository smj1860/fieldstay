import { render } from '@react-email/render'
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components'

interface GuidebookFeatureAnnouncementEmailProps {
  pmFirstName:  string
  dashboardUrl: string
  launchDate:   string // e.g. "[LAUNCH_DATE]" until confirmed
}

export function GuidebookFeatureAnnouncementEmail({
  pmFirstName,
  dashboardUrl,
  launchDate,
}: GuidebookFeatureAnnouncementEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Meet the guidebook your guests will actually use — and the local businesses that pay for it.
      </Preview>
      <Body style={styles.body}>

        {/* ── Header ───────────────────────────────────────────── */}
        <Container style={styles.wrapper}>
          <Section style={styles.header}>
            <Heading style={styles.logo}>FieldStay</Heading>
            <Text style={styles.headerTag}>Property Operations Platform</Text>
          </Section>

          {/* ── Hero ─────────────────────────────────────────────── */}
          <Section style={styles.hero}>
            <Text style={styles.eyebrow}>Introducing</Text>
            <Heading as="h1" style={styles.heroHeading}>
              The Guidebook That<br />Knows What Time It Is
            </Heading>
            <Text style={styles.heroSubtext}>
              Available {launchDate} — and it&apos;s already waiting in your dashboard.
            </Text>
          </Section>

          <Section style={styles.content}>

            {/* ── Opening narrative ──────────────────────────────── */}
            <Text style={styles.body1}>
              Hi {pmFirstName},
            </Text>
            <Text style={styles.body1}>
              Picture this: your guest wakes up at 8 AM in your Blue Ridge cabin.
              They don&apos;t know the area. They&apos;re thinking about coffee. They pull up
              your welcome guide — the PDF you spent three hours making last spring —
              and it lists a breakfast spot that closed six months ago.
            </Text>
            <Text style={styles.body1}>
              That&apos;s the problem with every guidebook in short-term rentals right now.
              They&apos;re static. They don&apos;t know it&apos;s Tuesday morning. They don&apos;t know
              it&apos;s raining. They don&apos;t know your guest has been awake since 6 AM
              wondering where to go.
            </Text>
            <Text style={styles.body1}>
              We built something different.
            </Text>

            {/* ── Contextual SMS examples ────────────────────────────────── */}
            <Heading as="h2" style={styles.sectionHeading}>
              It knows your property, too.
            </Heading>
            <Text style={styles.body1}>
              When a guest checks in, FieldStay reads their property — not just the
              time and weather, but what&apos;s actually there. A hot tub. A fire pit.
              Kayaks on the dock. Then it sends the right message at exactly the
              right moment.
            </Text>

            {/* Example SMS bubbles */}
            <Section style={styles.smsBubbleSection}>

              <Section style={styles.smsBubble}>
                <Text style={styles.smsLabel}>3:45 PM · Hot Tub detected at this property</Text>
                <Text style={styles.smsText}>
                  The hot tub at Bear Hollow takes about 45 minutes to heat. Set
                  it to 104° using the panel on the left side of the deck —
                  perfect timing if you want to be in by 6 PM. 🛁
                </Text>
              </Section>

              <Section style={styles.smsBubble}>
                <Text style={styles.smsLabel}>6:12 PM · Fire Pit + 68°F outside</Text>
                <Text style={styles.smsText}>
                  It&apos;s 68° tonight at Bear Hollow — perfect fire pit weather.
                  Starter logs are on the back porch. Heading out for dinner
                  first? The Farmhouse Table is 1.1 miles away. 🔥
                </Text>
              </Section>

            </Section>

            <Text style={styles.body1}>
              These aren&apos;t canned messages. They&apos;re generated from what
              your property actually has — pulled from your OwnerRez listings
              and updated every sync. A guest at a property with no fire pit
              never sees a fire pit message. A guest at a lakefront cabin sees
              kayak timing instead.
            </Text>

            <Text style={styles.body1}>
              The guest opted in when they entered their door code. They already
              expect to hear from you. That&apos;s why these messages open.
            </Text>

            <Hr style={styles.divider} />

            {/* ── What it is ─────────────────────────────────────── */}
            <Heading as="h2" style={styles.sectionHeading}>
              An ambient recommendation engine,<br />not a document.
            </Heading>
            <Text style={styles.body1}>
              The FieldStay Guidebook lives at a unique URL for each of your
              properties. Guests scan a QR code when they arrive, or tap a link
              in their booking confirmation. What they see isn&apos;t a list — it&apos;s a
              curated, real-time snapshot of exactly what&apos;s relevant to them
              right now.
            </Text>
            <Text style={styles.body1}>
              At 8 AM on a clear morning, they see your Morning Brew recommendation
              — the coffee shop you handpicked, with the specific drink your guests
              keep raving about. By 6 PM, it shifts to your Dinner pick, with a
              featured dish front and center. On a rainy afternoon, the outdoor
              adventure spot disappears entirely and a cozy Rainy Day hideaway
              takes its place.
            </Text>
            <Text style={styles.body1}>
              It reads the time. It checks the weather. It shows the right thing.
            </Text>

            {/* ── Slot grid ──────────────────────────────────────── */}
            <Section style={styles.slotGrid}>
              <Row>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>☀️</Text>
                  <Text style={styles.slotName}>Morning Brew</Text>
                  <Text style={styles.slotDesc}>7 AM – 11 AM</Text>
                </Column>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>🍷</Text>
                  <Text style={styles.slotName}>Dinner & Pints</Text>
                  <Text style={styles.slotDesc}>5 PM onwards</Text>
                </Column>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>🌧️</Text>
                  <Text style={styles.slotName}>Rainy Day</Text>
                  <Text style={styles.slotDesc}>When it rains</Text>
                </Column>
              </Row>
              <Row>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>🏕️</Text>
                  <Text style={styles.slotName}>Outdoor Adventure</Text>
                  <Text style={styles.slotDesc}>Clear skies, daytime</Text>
                </Column>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>📍</Text>
                  <Text style={styles.slotName}>General</Text>
                  <Text style={styles.slotDesc}>Always shown</Text>
                </Column>
                <Column style={styles.slotCard}>
                  <Text style={styles.slotEmoji}>✏️</Text>
                  <Text style={styles.slotName}>Custom</Text>
                  <Text style={styles.slotDesc}>You define it</Text>
                </Column>
              </Row>
            </Section>

            <Text style={styles.body1}>
              Every slot shows the business name, a short description, their
              exclusive offer for your guests, and — this is the detail that
              makes restaurants and coffee shops say yes immediately — a single
              featured item. &quot;Don&apos;t leave without trying the brown butter waffle.&quot;
              &quot;Ask for the seasonal old fashioned.&quot; That specificity is what
              separates this from a local directory.
            </Text>

            <Hr style={styles.divider} />

            {/* ── The sponsor model ──────────────────────────────── */}
            <Heading as="h2" style={styles.sectionHeading}>
              The businesses in your area pay for it. Not you.
            </Heading>
            <Text style={styles.body1}>
              Your guidebook has six sponsor slots. Each local business pays
              $15 a month for a placement — the coffee shop, the restaurant,
              the outfitter, the spa. You recruit them using a media kit
              FieldStay generates automatically for you. They sign up directly.
              You never touch a dollar.
            </Text>
            <Text style={styles.body1}>
              When you have <strong>4 active sponsors</strong>, your guidebook
              unlocks and goes live for every one of your properties —
              completely free, for as long as those sponsors stay active.
              No monthly fee. No trial. No catch.
            </Text>

            {/* ── Credit tiers callout ───────────────────────────── */}
            <Section style={styles.creditBox}>
              <Text style={styles.creditBoxHeading}>
                Fill all six slots and FieldStay pays you back.
              </Text>
              <Row>
                <Column style={styles.creditTier}>
                  <Text style={styles.creditTierNumber}>5</Text>
                  <Text style={styles.creditTierLabel}>sponsors</Text>
                  <Text style={styles.creditTierReward}>$10 off</Text>
                  <Text style={styles.creditTierSub}>your FieldStay plan/mo</Text>
                </Column>
                <Column style={styles.creditTierDivider} />
                <Column style={styles.creditTier}>
                  <Text style={styles.creditTierNumber}>6</Text>
                  <Text style={styles.creditTierLabel}>sponsors</Text>
                  <Text style={styles.creditTierReward}>$25 off</Text>
                  <Text style={styles.creditTierSub}>your FieldStay plan/mo</Text>
                </Column>
              </Row>
              <Text style={styles.creditBoxFooter}>
                Credits apply automatically to your next invoice. No codes, no requests.
              </Text>
            </Section>

            <Text style={styles.body1}>
              At six sponsors you&apos;re earning $90 a month in local business
              revenue, getting $25 back off your FieldStay plan, and delivering
              a guest experience that no PDF or Google Doc can come close to.
            </Text>

            <Hr style={styles.divider} />

            {/* ── How to start ───────────────────────────────────── */}
            <Heading as="h2" style={styles.sectionHeading}>
              How to get started
            </Heading>

            <Section style={styles.stepList}>
              <Row style={styles.stepRow}>
                <Column style={styles.stepNumber}><Text style={styles.stepNum}>1</Text></Column>
                <Column style={styles.stepBody}>
                  <Text style={styles.stepTitle}>Open your Guidebook dashboard</Text>
                  <Text style={styles.stepDesc}>
                    You&apos;ll see your six sponsor slots ready to fill in. Add a local
                    business to any slot — name, description, their offer for guests,
                    and the one item you want to call out.
                  </Text>
                </Column>
              </Row>
              <Row style={styles.stepRow}>
                <Column style={styles.stepNumber}><Text style={styles.stepNum}>2</Text></Column>
                <Column style={styles.stepBody}>
                  <Text style={styles.stepTitle}>Share your media kit</Text>
                  <Text style={styles.stepDesc}>
                    Each slot generates a unique, print-ready media kit with the
                    business&apos;s Stripe signup link built in. Hand it to the owner,
                    email it over, leave it at the counter. They sign up. You&apos;re done.
                  </Text>
                </Column>
              </Row>
              <Row style={styles.stepRow}>
                <Column style={styles.stepNumber}><Text style={styles.stepNum}>3</Text></Column>
                <Column style={styles.stepBody}>
                  <Text style={styles.stepTitle}>Hit 4 sponsors — your guidebook goes live</Text>
                  <Text style={styles.stepDesc}>
                    The moment your fourth sponsor activates, every one of your
                    properties gets a live, weather-aware, time-aware guidebook.
                    Your guests see it. Your sponsors see results. You see it in
                    five minutes of work.
                  </Text>
                </Column>
              </Row>
            </Section>

            {/* ── CTA ────────────────────────────────────────────── */}
            <Section style={styles.ctaSection}>
              <Button href={dashboardUrl} style={styles.ctaButton}>
                Meet My Guidebook →
              </Button>
              <Text style={styles.ctaSubtext}>
                Your six sponsor slots are waiting.
              </Text>
            </Section>

            <Hr style={styles.divider} />

            <Text style={styles.closing}>
              The FieldStay team
            </Text>

          </Section>

          {/* ── Footer ───────────────────────────────────────────── */}
          <Section style={styles.footer}>
            <Text style={styles.footerText}>
              FieldStay · Property Operations Platform
            </Text>
            <Text style={styles.footerText}>
              You&apos;re receiving this because you have an active FieldStay account.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderGuidebookFeatureAnnouncementEmail(
  props: GuidebookFeatureAnnouncementEmailProps
): Promise<string> {
  return render(<GuidebookFeatureAnnouncementEmail {...props} />)
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  body: {
    backgroundColor: '#f0f0f0',
    fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    margin:          '0',
    padding:         '0',
  },
  wrapper: {
    maxWidth:      '620px',
    margin:        '32px auto',
    backgroundColor: '#ffffff',
    borderRadius:  '12px',
    overflow:      'hidden' as const,
    boxShadow:     '0 2px 12px rgba(0,0,0,0.08)',
  },
  header: {
    backgroundColor: '#0f172a',
    padding:         '28px 40px',
  },
  logo: {
    color:      '#FCD116',
    fontSize:   '26px',
    fontWeight: '700',
    margin:     '0 0 4px',
    letterSpacing: '-0.5px',
  },
  headerTag: {
    color:     '#94a3b8',
    fontSize:  '12px',
    margin:    '0',
    letterSpacing: '0.5px',
    textTransform: 'uppercase' as const,
  },
  hero: {
    backgroundColor: '#0f172a',
    padding:         '0 40px 48px',
    borderBottom:    '3px solid #FCD116',
  },
  eyebrow: {
    color:         '#FCD116',
    fontSize:      '12px',
    fontWeight:    '600',
    letterSpacing: '2px',
    textTransform: 'uppercase' as const,
    margin:        '0 0 12px',
  },
  heroHeading: {
    color:        '#ffffff',
    fontSize:     '36px',
    fontWeight:   '800',
    lineHeight:   '1.15',
    margin:       '0 0 16px',
    letterSpacing: '-1px',
  },
  heroSubtext: {
    color:      '#94a3b8',
    fontSize:   '15px',
    margin:     '0',
    lineHeight: '1.5',
  },
  content: {
    padding: '40px',
  },
  body1: {
    color:      '#374151',
    fontSize:   '16px',
    lineHeight: '1.7',
    margin:     '0 0 18px',
  },
  divider: {
    borderColor: '#e5e7eb',
    margin:      '36px 0',
  },
  sectionHeading: {
    color:        '#0f172a',
    fontSize:     '22px',
    fontWeight:   '700',
    margin:       '0 0 20px',
    lineHeight:   '1.3',
    letterSpacing: '-0.3px',
  },
  smsBubbleSection: {
    margin: '24px 0',
  },
  smsBubble: {
    backgroundColor: '#f8fafc',
    borderLeft:      '3px solid #FCD116',
    borderRadius:    '0 10px 10px 0',
    padding:         '16px 20px',
    marginBottom:    '16px',
  },
  smsLabel: {
    color:         '#94a3b8',
    fontSize:      '11px',
    fontWeight:    '600',
    letterSpacing: '0.5px',
    textTransform: 'uppercase' as const,
    margin:        '0 0 8px',
  },
  smsText: {
    color:      '#1e293b',
    fontSize:   '15px',
    lineHeight: '1.65',
    margin:     '0',
    fontStyle:  'italic',
  },
  slotGrid: {
    backgroundColor: '#f8fafc',
    borderRadius:    '10px',
    padding:         '24px',
    margin:          '24px 0',
  },
  slotCard: {
    textAlign:   'center' as const,
    padding:     '12px 8px',
  },
  slotEmoji: {
    fontSize: '24px',
    margin:   '0 0 6px',
  },
  slotName: {
    color:      '#0f172a',
    fontSize:   '12px',
    fontWeight: '700',
    margin:     '0 0 2px',
  },
  slotDesc: {
    color:    '#6b7280',
    fontSize: '11px',
    margin:   '0',
  },
  creditBox: {
    backgroundColor: '#0f172a',
    borderRadius:    '12px',
    padding:         '32px',
    margin:          '28px 0',
  },
  creditBoxHeading: {
    color:      '#FCD116',
    fontSize:   '16px',
    fontWeight: '700',
    margin:     '0 0 24px',
    textAlign:  'center' as const,
  },
  creditTier: {
    textAlign: 'center' as const,
    padding:   '0 20px',
  },
  creditTierDivider: {
    borderLeft: '1px solid #1e293b',
    width:      '1px',
  },
  creditTierNumber: {
    color:      '#ffffff',
    fontSize:   '48px',
    fontWeight: '800',
    margin:     '0',
    lineHeight: '1',
  },
  creditTierLabel: {
    color:    '#64748b',
    fontSize: '13px',
    margin:   '4px 0 16px',
  },
  creditTierReward: {
    color:      '#FCD116',
    fontSize:   '24px',
    fontWeight: '800',
    margin:     '0 0 4px',
  },
  creditTierSub: {
    color:    '#64748b',
    fontSize: '12px',
    margin:   '0',
  },
  creditBoxFooter: {
    color:     '#475569',
    fontSize:  '13px',
    textAlign: 'center' as const,
    margin:    '24px 0 0',
  },
  stepList: {
    margin: '8px 0 32px',
  },
  stepRow: {
    marginBottom: '20px',
  },
  stepNumber: {
    width:          '40px',
    verticalAlign:  'top' as const,
    paddingTop:     '2px',
  },
  stepNum: {
    backgroundColor: '#FCD116',
    color:           '#0f172a',
    fontSize:        '14px',
    fontWeight:      '800',
    width:           '32px',
    height:          '32px',
    borderRadius:    '50%',
    textAlign:       'center' as const,
    lineHeight:      '32px',
    margin:          '0',
    display:         'inline-block',
  },
  stepBody: {
    paddingLeft: '16px',
    verticalAlign: 'top' as const,
  },
  stepTitle: {
    color:      '#0f172a',
    fontSize:   '15px',
    fontWeight: '700',
    margin:     '0 0 4px',
  },
  stepDesc: {
    color:      '#6b7280',
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0',
  },
  ctaSection: {
    textAlign: 'center' as const,
    margin:    '8px 0 16px',
  },
  ctaButton: {
    backgroundColor: '#FCD116',
    color:           '#0f172a',
    fontSize:        '16px',
    fontWeight:      '700',
    padding:         '16px 40px',
    borderRadius:    '8px',
    textDecoration:  'none',
    display:         'inline-block',
    letterSpacing:   '0.2px',
  },
  ctaSubtext: {
    color:     '#9ca3af',
    fontSize:  '13px',
    margin:    '16px 0 0',
  },
  closing: {
    color:     '#6b7280',
    fontSize:  '15px',
    margin:    '0',
  },
  footer: {
    backgroundColor: '#f8fafc',
    padding:         '24px 40px',
    borderTop:       '1px solid #e5e7eb',
  },
  footerText: {
    color:     '#9ca3af',
    fontSize:  '12px',
    margin:    '0 0 4px',
    textAlign: 'center' as const,
  },
}
