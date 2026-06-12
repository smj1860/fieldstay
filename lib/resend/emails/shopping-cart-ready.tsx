import { Section, Text, Button, Hr } from '@react-email/components'
import { render } from '@react-email/render'
import { BaseLayout } from './base-layout'
import type { CartBuildResult } from '@/lib/kroger/types'

export interface ShoppingCartReadyEmailProps {
  cartData:      CartBuildResult & { built_at: string; location_name: string }
  recipientName: string
}

const STATUS_LABELS: Record<CartBuildResult['status'], string> = {
  cart_added: 'Cart built successfully',
  partial:    'Cart partially built',
  list_only:  'Shopping list ready (cart not added)',
}

export function ShoppingCartReadyEmail({ cartData, recipientName }: ShoppingCartReadyEmailProps) {
  const statusLabel    = STATUS_LABELS[cartData.status] ?? cartData.status
  const matchedCount   = cartData.matched_items.length
  const unmatchedCount = cartData.unmatched_items.length
  const hasCart        = cartData.status === 'cart_added' || cartData.status === 'partial'
  const totalEst       = cartData.total_est != null
    ? `$${cartData.total_est.toFixed(2)}`
    : null

  return (
    <BaseLayout
      previewText={`Your Kroger restock cart is ready — ${matchedCount} item${matchedCount !== 1 ? 's' : ''} added`}
      headerSub="Kroger Restock"
      footerLine={`Below-par inventory restock · ${new Date(cartData.built_at).toLocaleString()}`}
    >
      <Text style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>
        Your Kroger cart is ready
      </Text>
      <Text style={{ fontSize: 14, color: '#475569', margin: '0 0 20px', lineHeight: 1.5 }}>
        Hi {recipientName} — FieldStay finished building your below-par restock list.
      </Text>

      {/* Status pill */}
      <Section style={{ marginBottom: 20 }}>
        <Text style={{
          display: 'inline-block',
          padding: '4px 12px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          backgroundColor: hasCart ? '#d1fae5' : '#fef3c7',
          color:           hasCart ? '#065f46' : '#92400e',
          margin: 0,
        }}>
          {statusLabel}
        </Text>
      </Section>

      {/* Stats */}
      <Section style={{ marginBottom: 24 }}>
        <Section style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 8, marginBottom: 8 }}>
          <Text style={{ fontSize: 14, color: '#475569', margin: 0, display: 'inline' }}>Items matched</Text>
          <Text style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: 0, float: 'right' }}>{matchedCount}</Text>
        </Section>
        {unmatchedCount > 0 && (
          <Section style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 8, marginBottom: 8 }}>
            <Text style={{ fontSize: 14, color: '#475569', margin: 0, display: 'inline' }}>Items not found</Text>
            <Text style={{ fontSize: 14, fontWeight: 600, color: '#d97706', margin: 0, float: 'right' }}>{unmatchedCount}</Text>
          </Section>
        )}
        {totalEst && (
          <Section>
            <Text style={{ fontSize: 14, color: '#475569', margin: 0, display: 'inline' }}>Estimated total</Text>
            <Text style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: 0, float: 'right' }}>{totalEst}</Text>
          </Section>
        )}
      </Section>

      {/* Open Cart CTA */}
      {cartData.cart_url && (
        <>
          <Button
            href={cartData.cart_url}
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
            Open Cart →
          </Button>
          <Text style={{ fontSize: 12, color: '#94a3b8', margin: '8px 0 20px' }}>
            Store: {cartData.location_name}
          </Text>
        </>
      )}

      {/* Unmatched items */}
      {cartData.unmatched_items.length > 0 && (
        <>
          <Hr style={{ borderColor: '#e2e8f0', margin: '4px 0 16px' }} />
          <Text style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 10px' }}>
            Items not found — search manually:
          </Text>
          {cartData.unmatched_items.map((name) => {
            const searchUrl = `https://www.kroger.com/search?query=${encodeURIComponent(name)}`
            return (
              <Text key={name} style={{ fontSize: 13, color: '#475569', margin: '0 0 6px' }}>
                · <a href={searchUrl} style={{ color: '#2563eb', textDecoration: 'underline' }}>{name}</a>
              </Text>
            )
          })}
        </>
      )}
    </BaseLayout>
  )
}

export async function renderShoppingCartReadyEmail(props: ShoppingCartReadyEmailProps): Promise<string> {
  return render(<ShoppingCartReadyEmail {...props} />)
}
