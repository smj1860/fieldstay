import { Html, Head, Body, Container, Section, Text, Preview } from '@react-email/components'

interface BaseLayoutProps {
  previewText?: string
  children:     React.ReactNode
}

/**
 * Shared shell for PM-facing alert emails (maintenance, asset health,
 * compliance, work order, inventory, booking notifications).
 * Mirrors the FieldStay branded header used in work-order-vendor.tsx.
 */
export function BaseLayout({ previewText, children }: BaseLayoutProps) {
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
          </Section>

          <Section style={{ backgroundColor: '#ffffff', padding: '28px 32px', borderRadius: '0 0 12px 12px' }}>
            {children}
          </Section>

        </Container>
      </Body>
    </Html>
  )
}
