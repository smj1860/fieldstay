import type { CartBuildResult } from '@/lib/kroger/types'

interface ShoppingCartReadyEmailProps {
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
    <div style={{ fontFamily: 'sans-serif', maxWidth: '560px', margin: '0 auto', padding: '32px', color: '#0a1628' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700 }}>
        🛒 Your Kroger cart is ready
      </h2>
      <p style={{ margin: '0 0 24px', color: '#5a6a7a', fontSize: '14px' }}>
        Hi {recipientName} — FieldStay finished building your below-par restock list.
      </p>

      {/* Status pill */}
      <div style={{
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: 600,
        marginBottom: '20px',
        background: hasCart ? '#d1fae5' : '#fef3c7',
        color:      hasCart ? '#065f46' : '#92400e',
      }}>
        {statusLabel}
      </div>

      {/* Stats */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px' }}>
        <tbody>
          <tr>
            <td style={{ padding: '10px 0', borderBottom: '1px solid #e5e9ef', color: '#5a6a7a', fontSize: '14px' }}>
              Items matched
            </td>
            <td style={{ padding: '10px 0', borderBottom: '1px solid #e5e9ef', textAlign: 'right', fontWeight: 600, fontSize: '14px' }}>
              {matchedCount}
            </td>
          </tr>
          {unmatchedCount > 0 && (
            <tr>
              <td style={{ padding: '10px 0', borderBottom: '1px solid #e5e9ef', color: '#5a6a7a', fontSize: '14px' }}>
                Items not found
              </td>
              <td style={{ padding: '10px 0', borderBottom: '1px solid #e5e9ef', textAlign: 'right', fontWeight: 600, fontSize: '14px', color: '#d97706' }}>
                {unmatchedCount}
              </td>
            </tr>
          )}
          {totalEst && (
            <tr>
              <td style={{ padding: '10px 0', color: '#5a6a7a', fontSize: '14px' }}>
                Estimated total
              </td>
              <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 700, fontSize: '16px' }}>
                {totalEst}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Open Cart CTA */}
      {cartData.cart_url && (
        <div style={{ marginBottom: '28px' }}>
          <a
            href={cartData.cart_url}
            style={{
              display: 'inline-block',
              background: '#FCD116',
              color: '#0a1628',
              fontWeight: 700,
              fontSize: '15px',
              padding: '12px 28px',
              borderRadius: '8px',
              textDecoration: 'none',
            }}
          >
            Open Cart →
          </a>
          <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#8a9bb0' }}>
            Store: {cartData.location_name}
          </p>
        </div>
      )}

      {/* Unmatched items */}
      {cartData.unmatched_items.length > 0 && (
        <div>
          <p style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#0a1628' }}>
            Items not found — search manually:
          </p>
          <ul style={{ margin: 0, padding: '0 0 0 20px', listStyle: 'disc' }}>
            {cartData.unmatched_items.map((name) => {
              const searchUrl = `https://www.kroger.com/search?query=${encodeURIComponent(name)}`
              return (
                <li key={name} style={{ marginBottom: '6px', fontSize: '13px' }}>
                  <a
                    href={searchUrl}
                    style={{ color: '#2563eb', textDecoration: 'underline' }}
                  >
                    {name}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <hr style={{ margin: '28px 0', border: 'none', borderTop: '1px solid #e5e9ef' }} />
      <p style={{ fontSize: '12px', color: '#8a9bb0', margin: 0 }}>
        FieldStay · Below-par inventory restock · {new Date(cartData.built_at).toLocaleString()}
      </p>
    </div>
  )
}

export function shoppingCartReadyHtml(props: ShoppingCartReadyEmailProps): string {
  const { cartData, recipientName } = props
  const statusLabel    = STATUS_LABELS[cartData.status] ?? cartData.status
  const matchedCount   = cartData.matched_items.length
  const unmatchedCount = cartData.unmatched_items.length
  const hasCart        = cartData.status === 'cart_added' || cartData.status === 'partial'
  const totalEst       = cartData.total_est != null ? `$${cartData.total_est.toFixed(2)}` : null

  const unmatchedRows = cartData.unmatched_items
    .map(name => {
      const searchUrl = `https://www.kroger.com/search?query=${encodeURIComponent(name)}`
      return `<li style="margin-bottom:6px;font-size:13px;"><a href="${searchUrl}" style="color:#2563eb;text-decoration:underline;">${name}</a></li>`
    })
    .join('')

  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#0a1628;">
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;">🛒 Your Kroger cart is ready</h2>
      <p style="margin:0 0 24px;color:#5a6a7a;font-size:14px;">Hi ${recipientName} — FieldStay finished building your below-par restock list.</p>
      <div style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:20px;background:${hasCart ? '#d1fae5' : '#fef3c7'};color:${hasCart ? '#065f46' : '#92400e'};">${statusLabel}</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e9ef;color:#5a6a7a;font-size:14px;">Items matched</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e9ef;text-align:right;font-weight:600;font-size:14px;">${matchedCount}</td>
        </tr>
        ${unmatchedCount > 0 ? `<tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e9ef;color:#5a6a7a;font-size:14px;">Items not found</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e9ef;text-align:right;font-weight:600;font-size:14px;color:#d97706;">${unmatchedCount}</td>
        </tr>` : ''}
        ${totalEst ? `<tr>
          <td style="padding:10px 0;color:#5a6a7a;font-size:14px;">Estimated total</td>
          <td style="padding:10px 0;text-align:right;font-weight:700;font-size:16px;">${totalEst}</td>
        </tr>` : ''}
      </table>
      ${cartData.cart_url ? `
        <div style="margin-bottom:28px;">
          <a href="${cartData.cart_url}" style="display:inline-block;background:#FCD116;color:#0a1628;font-weight:700;font-size:15px;padding:12px 28px;border-radius:8px;text-decoration:none;">Open Cart →</a>
          <p style="margin:8px 0 0;font-size:12px;color:#8a9bb0;">Store: ${cartData.location_name}</p>
        </div>` : ''}
      ${cartData.unmatched_items.length > 0 ? `
        <div>
          <p style="font-size:13px;font-weight:600;margin-bottom:8px;color:#0a1628;">Items not found — search manually:</p>
          <ul style="margin:0;padding:0 0 0 20px;list-style:disc;">${unmatchedRows}</ul>
        </div>` : ''}
      <hr style="margin:28px 0;border:none;border-top:1px solid #e5e9ef;" />
      <p style="font-size:12px;color:#8a9bb0;margin:0;">FieldStay · Below-par inventory restock · ${new Date(cartData.built_at).toLocaleString()}</p>
    </div>
  `
}
