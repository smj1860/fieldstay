import { Text, Section } from '@react-email/components'
import { render } from '@react-email/render'
import { EmailLayout } from './components/email-layout'

interface Props {
  organizationName:   string
  sequenceNumber:     number | null // null for the tier-2 (1-year) lock
  lockYears:          1 | 2
  lockedTierName:     string
  lockedPriceDisplay: string // e.g. "$479/mo"
}

export function HospitablePriceLockEmail({
  organizationName,
  sequenceNumber,
  lockYears,
  lockedTierName,
  lockedPriceDisplay,
}: Props) {
  const isFirst100 = sequenceNumber !== null

  return (
    <EmailLayout
      preview={
        isFirst100
          ? "You're one of FieldStay's first 100 Hospitable-connected customers"
          : 'Your FieldStay plan is price-locked, on us'
      }
      footerNote={`You're receiving this because ${organizationName} connected FieldStay via Hospitable.`}
    >
      <Text style={eyebrow}>
        {isFirst100 ? 'LAUNCH PROMO — FIRST 100' : 'LAUNCH PROMO'}
      </Text>
      <Text style={heading}>
        {isFirst100
          ? `Welcome to the first 100, ${organizationName}.`
          : `Thank you for connecting via Hospitable, ${organizationName}.`}
      </Text>

      {isFirst100 ? (
        <Text style={body}>
          You&apos;re customer #{sequenceNumber} of the first 100 property managers to
          join FieldStay through our Hospitable integration launch — and that
          comes with a thank-you from us.
        </Text>
      ) : (
        <Text style={body}>
          Our first 100 launch spots went faster than we expected — genuinely,
          thank you. We still wanted to do something for everyone who joined
          FieldStay through the Hospitable integration, so your plan is
          price-locked too.
        </Text>
      )}

      <Section style={highlightBox}>
        <Text style={highlightHeading}>
          Your {lockedTierName} plan is price-locked at {lockedPriceDisplay} for{' '}
          {lockYears} {lockYears === 1 ? 'year' : 'years'}.
        </Text>
        <Text style={highlightText}>
          No matter what our list price does during that time, your per-property
          rates stay exactly where they are today. (Your bill can still change if
          you add or remove properties — this locks the RATE you pay, not a flat
          dollar amount, since FieldStay bills per property.)
        </Text>
      </Section>

      <Text style={body}>
        You&apos;ll see a Price Lock badge on your account settings page as a
        permanent record of this.
      </Text>

      <Text style={signature}>
        Thanks for being an early believer in FieldStay — reach out any time at
        stephen@fieldstay.app if you ever need anything directly from me.
        <br />
        — Stephen, Founder
      </Text>
    </EmailLayout>
  )
}

export async function renderHospitablePriceLockEmail(props: Props): Promise<string> {
  return render(<HospitablePriceLockEmail {...props} />)
}

const eyebrow: React.CSSProperties = {
  fontSize:      11,
  fontWeight:    700,
  color:         '#b45309',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin:        '0 0 8px',
}

const heading: React.CSSProperties = {
  fontSize:   24,
  fontWeight: 700,
  color:      '#0a1628',
  margin:     '0 0 20px',
  lineHeight: '1.2',
}

const body: React.CSSProperties = {
  fontSize:   15,
  color:      '#374151',
  lineHeight: '1.6',
  margin:     '0 0 16px',
}

const highlightBox: React.CSSProperties = {
  backgroundColor: '#fffbeb',
  border:          '1px solid #fde68a',
  borderRadius:    10,
  padding:         '16px 20px',
  margin:          '0 0 20px',
}

const highlightHeading: React.CSSProperties = {
  fontSize:   15,
  fontWeight: 600,
  color:      '#92400e',
  margin:     0,
  lineHeight: '1.5',
}

const highlightText: React.CSSProperties = {
  fontSize:   14,
  color:      '#78716c',
  margin:     '8px 0 0',
  lineHeight: '1.6',
}

const signature: React.CSSProperties = {
  fontSize:   14,
  color:      '#78716c',
  margin:     '24px 0 0',
  lineHeight: '1.6',
}
