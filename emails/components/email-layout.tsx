import {
  Html, Head, Body, Container, Section,
  Text, Button, Hr, Link, Preview, Row, Column,
} from '@react-email/components'

interface EmailLayoutProps {
  preview:     string
  children:    React.ReactNode
  ctaLabel?:   string
  ctaUrl?:     string
  footerNote?: string
}

export function EmailLayout({
  preview,
  children,
  ctaLabel,
  ctaUrl,
  footerNote,
}: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>

        {/* Header */}
        <Section style={header}>
          <Container style={headerInner}>
            <Text style={logoText}>FieldStay</Text>
            <Text style={taglineText}>Field Operations Platform</Text>
          </Container>
        </Section>

        {/* Content card */}
        <Container style={card}>
          {children}

          {ctaLabel && ctaUrl && (
            <Section style={{ textAlign: 'center', marginTop: 32 }}>
              <Button href={ctaUrl} style={ctaButton}>
                {ctaLabel}
              </Button>
            </Section>
          )}
        </Container>

        {/* Footer */}
        <Container style={footer}>
          <Hr style={footerHr} />
          {footerNote && (
            <Text style={footerSmall}>{footerNote}</Text>
          )}
          <Row>
            <Column>
              <Text style={footerSmall}>
                © {new Date().getFullYear()} FieldStay · All rights reserved
              </Text>
            </Column>
          </Row>
          <Row>
            <Column>
              <Link href="https://app.fieldstay.app/privacy" style={footerLink}>
                Privacy Policy
              </Link>
              {' · '}
              <Link href="https://app.fieldstay.app/terms" style={footerLink}>
                Terms
              </Link>
              {' · '}
              <Link href="mailto:support@fieldstay.app" style={footerLink}>
                Support
              </Link>
            </Column>
          </Row>
        </Container>

      </Body>
    </Html>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────

const body: React.CSSProperties = {
  backgroundColor: '#f1f5f9',
  fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  margin:          0,
  padding:         0,
}

const header: React.CSSProperties = {
  backgroundColor: '#0a1628',
  padding:         '32px 0 28px',
}

const headerInner: React.CSSProperties = {
  maxWidth:  600,
  margin:    '0 auto',
  padding:   '0 32px',
  textAlign: 'center',
}

const logoText: React.CSSProperties = {
  color:         '#FCD116',
  fontSize:      28,
  fontWeight:    700,
  margin:        0,
  lineHeight:    '1.2',
  letterSpacing: '-0.5px',
}

const taglineText: React.CSSProperties = {
  color:         '#ffffff',
  fontSize:      12,
  fontWeight:    500,
  margin:        '4px 0 0',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const card: React.CSSProperties = {
  backgroundColor: '#ffffff',
  maxWidth:        600,
  margin:          '0 auto',
  padding:         '40px 48px 48px',
  borderRadius:    '0 0 16px 16px',
}

const ctaButton: React.CSSProperties = {
  backgroundColor: '#FCD116',
  color:           '#0a1628',
  fontWeight:      700,
  fontSize:        15,
  padding:         '14px 32px',
  borderRadius:    10,
  textDecoration:  'none',
  display:         'inline-block',
}

const footer: React.CSSProperties = {
  maxWidth: 600,
  margin:   '24px auto 0',
  padding:  '0 32px 48px',
}

const footerHr: React.CSSProperties = {
  borderColor: '#e2e8f0',
  margin:      '0 0 20px',
}

const footerSmall: React.CSSProperties = {
  color:    '#94a3b8',
  fontSize: 12,
  margin:   '0 0 4px',
}

const footerLink: React.CSSProperties = {
  color:          '#94a3b8',
  fontSize:       12,
  textDecoration: 'none',
}
