import { Section, Text, Hr } from '@react-email/components'
import { render }             from '@react-email/render'
import { EmailLayout }        from '@/emails/components/email-layout'
import type { CartBuildResult } from '@/lib/kroger/types'

export interface ShoppingCartReadyEmailProps {
  cartData:      CartBuildResult & { built_at: string; location_name: string }
  recipientName: string
}

const STATUS_LABELS: Record<CartBuildResult['status'], string> = {
  cart_added:          'Cart built successfully',
  partial:             'Cart partially built',
  list_only:           'Shopping list ready (cart not added)',
  nothing_below_par:   'Nothing below par',
  retailer_not_kroger: 'Retailer not set to Kroger',
  no_store_configured: 'No Kroger store configured',
}

export function ShoppingCartReadyEmail({
  cartData, recipientName,
}: ShoppingCartReadyEmailProps) {
  const statusLabel    = STATUS_LABELS[cartData.status] ?? cartData.status
  const matchedCount   = cartData.matched_items.length
  const unmatchedCount = cartData.unmatched_items.length
  const hasCart        = cartData.status === 'cart_added' || cartData.status === 'partial'
  const totalEst       = cartData.total_est != null
    ? `$${cartData.total_est.toFixed(2)}`
    : null

  return (
    <EmailLayout
      preview={`Your Kroger restock cart is ready — ${matchedCount} item${matchedCount !== 1 ? 's' : ''} added`}
      ctaLabel={cartData.cart_url ? 'Open Cart →' : undefined}
      ctaUrl={cartData.cart_url ?? undefined}
      footerNote={`Below-par inventory restock · ${new Date(cartData.built_at).toLocaleString()}`}
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0a1628', margin: '0 0 4px' }}>
        Your Kroger cart is ready
      </Text>

      <Text style={{ fontSize: 14, color: '#374151', margin: '0 0 20px', lineHeight: 1.5 }}>
        Hi {recipientName} — FieldStay finished building your below-par restock list.
      </Text>

      {/* Status pill */}
      <Section style={{ marginBottom: 20 }}>
        <Text
          style={{
            display:         'inline-block',
            padding:         '4px 12px',
            borderRadius:    999,
            fontSize:        12,
            fontWeight:      600,
            backgroundColor: hasCart ? '#d1fae5' : '#fef3c7',
            color:           hasCart ? '#065f46' : '#92400e',
            margin:          0,
          }}
        >
          {statusLabel}
        </Text>
      </Section>

      {/* Stats */}
      <Section style={{ marginBottom: 24 }}>
        <Section style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 8, marginBottom: 8 }}>
          <Text style={{ fontSize: 14, color: '#374151', margin: 0 }}>
            Items matched: <strong>{matchedCount}</strong>
          </Text>
        </Section>
        {unmatchedCount > 0 && (
          <Section style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 8, marginBottom: 8 }}>
            <Text style={{ fontSize: 14, color: '#374151', margin: 0 }}>
              Items not found: <strong style={{ color: '#d97706' }}>{unmatchedCount}</strong>
            </Text>
          </Section>
        )}
        {totalEst && (
          <Section>
            <Text style={{ fontSize: 14, color: '#374151', margin: 0 }}>
              Estimated total: <strong style={{ fontSize: 16 }}>{totalEst}</strong>
            </Text>
          </Section>
        )}
      </Section>

      {cartData.cart_url && (
        <Text style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 20px' }}>
          Store: {cartData.location_name}
        </Text>
      )}

      {/* Unmatched items */}
      {cartData.unmatched_items.length > 0 && (
        <>
          <Hr style={{ borderColor: '#e2e8f0', margin: '4px 0 16px' }} />
          <Text style={{ fontSize: 13, fontWeight: 600, color: '#0a1628', margin: '0 0 10px' }}>
            Items not found — search manually:
          </Text>
          {cartData.unmatched_items.map((name) => {
            const searchUrl = `https://www.kroger.com/search?query=${encodeURIComponent(name)}`
            return (
              <Text key={name} style={{ fontSize: 13, color: '#374151', margin: '0 0 6px' }}>
                ·{' '}
                <a href={searchUrl} style={{ color: '#0a1628', textDecoration: 'underline' }}>
                  {name}
                </a>
              </Text>
            )
          })}
        </>
      )}
    </EmailLayout>
  )
}

export async function renderShoppingCartReadyEmail(
  props: ShoppingCartReadyEmailProps
): Promise<string> {
  return render(<ShoppingCartReadyEmail {...props} />)
}
