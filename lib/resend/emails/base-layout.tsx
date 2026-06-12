import { Html, Head, Body, Container, Section, Text, Preview } from '@react-email/components'

interface BaseLayoutProps {
  previewText?: string
  headerSub?:   string
  footerLine?:  string
  children:     React.ReactNode
}

export function BaseLayout({ previewText, headerSub, footerLine, children }: BaseLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      {previewText && <Preview>{previewText}</Preview>}
      <Body style={{ backgroundColor: '#f1f5f9', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: 600, margin: '32px auto', padding: 0 }}>

          <Section style={{ backgroundColor: '#0a1628', borderRadius: '12px 12px 0 0', padding: '28px 32px' }}>
            <Text style={{ color: '#FCD116', fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', margin: 0, lineHeight: 1 }}>
              FieldStay
            </Text>
            {headerSub && (
              <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', margin: '6px 0 0' }}>
                {headerSub}
              </Text>
            )}
          </Section>

          <Section style={{ backgroundColor: '#ffffff', padding: '28px 32px', borderRadius: '0 0 12px 12px' }}>
            {children}
          </Section>

          <Section style={{ padding: '16px 32px 8px' }}>
            {footerLine && (
              <Text style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 4px', textAlign: 'center' }}>
                {footerLine}
              </Text>
            )}
            <Text style={{ fontSize: 11, color: '#cbd5e1', margin: '4px 0 0', textAlign: 'center' }}>
              Powered by FieldStay · fieldstay.app
            </Text>
          </Section>

        </Container>
      </Body>
    </Html>
  )
}
