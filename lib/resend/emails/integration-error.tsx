import { Text } from '@react-email/components'
import { render }        from '@react-email/render'
import { EmailLayout }   from '@/emails/components/email-layout'

export interface IntegrationErrorEmailProps {
  providerName: string
  reason:       string
  reconnectUrl: string
}

export function IntegrationErrorEmail({
  providerName, reason, reconnectUrl,
}: IntegrationErrorEmailProps) {
  return (
    <EmailLayout
      preview={`Action required — Your ${providerName} connection needs attention`}
      ctaLabel={`Reconnect ${providerName} →`}
      ctaUrl={reconnectUrl}
      footerNote="You're receiving this because you have an active FieldStay account."
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0a1628', margin: '0 0 12px' }}>
        Your {providerName} connection has been interrupted
      </Text>

      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 12px' }}>
        {reason}
      </Text>

      <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 24px' }}>
        Your booking data and owner P&amp;L reports may be out of date
        until you reconnect.
      </Text>
    </EmailLayout>
  )
}

export async function renderIntegrationErrorEmail(
  props: IntegrationErrorEmailProps
): Promise<string> {
  return render(<IntegrationErrorEmail {...props} />)
}
