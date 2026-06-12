import { Section, Text, Button } from '@react-email/components'
import { render } from '@react-email/render'
import { BaseLayout } from './base-layout'

export interface IntegrationErrorEmailProps {
  providerName: string
  reason:       string
  reconnectUrl: string
}

export function IntegrationErrorEmail({ providerName, reason, reconnectUrl }: IntegrationErrorEmailProps) {
  return (
    <BaseLayout
      previewText={`Action required — Your ${providerName} connection needs attention`}
      headerSub="Integration Alert"
      footerLine="You're receiving this because you have an active FieldStay account."
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 12px' }}>
        Your {providerName} connection has been interrupted
      </Text>
      <Text style={{ fontSize: 14, color: '#475569', lineHeight: 1.6, margin: '0 0 12px' }}>
        {reason}
      </Text>
      <Text style={{ fontSize: 14, color: '#475569', lineHeight: 1.6, margin: '0 0 24px' }}>
        Your booking data and owner P&L reports may be out of date until you reconnect.
      </Text>

      <Button
        href={reconnectUrl}
        style={{
          backgroundColor: '#FCD116',
          color: '#0a1628',
          fontWeight: 700,
          fontSize: 15,
          padding: '12px 28px',
          borderRadius: 8,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Reconnect {providerName} →
      </Button>
    </BaseLayout>
  )
}

export async function renderIntegrationErrorEmail(props: IntegrationErrorEmailProps): Promise<string> {
  return render(<IntegrationErrorEmail {...props} />)
}
