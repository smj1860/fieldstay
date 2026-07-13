import {
  Html, Head, Body, Container, Section,
  Text, Button, Link, Preview, Row, Column,
} from '@react-email/components'

interface EmailLayoutProps {
  preview:     string
  headerSub?:  string
  children:    React.ReactNode
  ctaLabel?:   string
  ctaUrl?:     string
  footerNote?: string
}

export function EmailLayout({
  preview,
  headerSub,
  children,
  ctaLabel,
  ctaUrl,
  footerNote,
}: Readonly<EmailLayoutProps>) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Container style={outerContainer}>

          {/* Header */}
          <Section style={header}>
            <Text style={logoText}>FieldStay</Text>
            {headerSub ? (
              <Text style={headerSubText}>{headerSub}</Text>
            ) : (
              <Text style={taglineText}>Field Operations Platform</Text>
            )}
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

        </Container>

        {/* Footer — intentionally outside/below the card, unboxed */}
        <Container style={footer}>
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

const outerContainer: React.CSSProperties = {
  maxWidth:     600,
  margin:       '32px auto 0',
  borderRadius: 16,
  overflow:     'hidden',
  boxShadow:    '0 1px 3px rgba(10,22,40,0.08), 0 8px 24px rgba(10,22,40,0.06)',
}

const header: React.CSSProperties = {
  backgroundColor: '#0a1628',
  padding:         '32px 32px 26px',
  textAlign:       'center',
}

const logoText: React.CSSProperties = {
  color:         '#FCD116',
  fontSize:      26,
  fontWeight:    800,
  margin:        0,
  lineHeight:    1.2,
  letterSpacing: '-0.5px',
}

const taglineText: React.CSSProperties = {
  color:         '#94a3b8',
  fontSize:      11,
  fontWeight:    600,
  margin:        '6px 0 0',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
}

const headerSubText: React.CSSProperties = {
  color:         '#94a3b8',
  fontSize:      11,
  fontWeight:    600,
  margin:        '6px 0 0',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
}

const card: React.CSSProperties = {
  backgroundColor: '#ffffff',
  padding:         '40px 40px 44px',
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
  margin:   '20px auto 0',
  padding:  '0 32px 40px',
}

const footerSmall: React.CSSProperties = {
  fontSize:  12,
  color:     '#94a3b8',
  margin:    '0 0 4px',
  textAlign: 'center',
}

const footerLink: React.CSSProperties = {
  fontSize:  12,
  color:     '#94a3b8',
  textDecoration: 'underline',
}
