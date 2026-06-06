'use client'

import type { CartBuildResult } from '@/lib/kroger/types'

interface CartReadyBannerProps {
  cartData: CartBuildResult & {
    built_at:      string
    location_name: string
  }
}

export function CartReadyBanner({ cartData }: CartReadyBannerProps) {
  const cartAdded  = cartData.status === 'cart_added'
  const matchCount = cartData.matched_items?.length ?? 0
  const missCount  = cartData.unmatched_items?.length ?? 0
  const totalEst   = cartData.total_est

  return (
    <div
      className="rounded-xl p-4 mb-4"
      style={{
        background: cartAdded ? 'rgba(16,185,129,0.07)' : 'var(--bg-card)',
        border:     cartAdded
          ? '1px solid rgba(16,185,129,0.3)'
          : '1px solid var(--border)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl flex-shrink-0">
            {cartAdded ? '🛒' : '📋'}
          </span>
          <div>
            <p
              className="font-semibold text-sm"
              style={{ color: 'var(--text-primary)' }}
            >
              {cartAdded
                ? `${matchCount} items added to your ${cartData.location_name} cart`
                : `Shopping list ready — ${matchCount} items found`}
            </p>
            <p
              className="text-xs mt-0.5"
              style={{ color: 'var(--text-muted)' }}
            >
              {totalEst ? `Est. $${totalEst.toFixed(2)} · ` : ''}
              {missCount > 0
                ? `${missCount} items need manual search`
                : 'All items matched'}
            </p>
          </div>
        </div>

        {cartAdded && cartData.cart_url && (
          <a
            href={cartData.cart_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap flex-shrink-0"
          >
            Open Cart →
          </a>
        )}
      </div>

      {missCount > 0 && (
        <div
          className="mt-3 pt-3"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <p
            className="text-xs font-medium mb-1.5"
            style={{ color: 'var(--text-muted)' }}
          >
            Search manually on {cartData.location_name}:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {cartData.unmatched_items.map(item => (
              <a
                key={item}
                href={`https://www.kroger.com/search?query=${encodeURIComponent(item)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2 py-1 rounded-md"
                style={{
                  background: 'var(--accent-amber-dim)',
                  color:      'var(--accent-amber)',
                  border:     '1px solid var(--accent-amber)',
                }}
              >
                {item} ↗
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}