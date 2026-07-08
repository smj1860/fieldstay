'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { GuidebookSponsor } from '@/types/database'

const CHARCOAL  = '#0E0E0E'
const CARD      = '#17171A'
const BORDER    = '#2A2A2E'
const TEXT      = '#F4F4F5'
const MUTED     = '#9A9AA2'
const GOLD      = '#D4A537'
const GREEN     = '#3FB97A'
const RED       = '#E5534B'

interface MediaKitClientProps {
  sponsor: GuidebookSponsor
}

export function MediaKitClient({ sponsor }: MediaKitClientProps) {
  const searchParams = useSearchParams()
  const success       = searchParams.get('success') === 'true'
  const cancelled     = searchParams.get('cancelled') === 'true'

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const isActive = sponsor.status === 'active'

  async function handleCheckout() {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/guidebook/sponsor-checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mediaKitToken: sponsor.media_kit_token }),
      })

      const json = await res.json() as { url?: string; error?: string }

      if (!res.ok || !json.url) {
        setError(json.error ?? 'Something went wrong. Please try again.')
        setIsLoading(false)
        return
      }

      window.location.href = json.url
    } catch {
      setError('Something went wrong. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: CHARCOAL, color: TEXT, padding: '24px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 8px' }}>
          Sponsor the Guest Guidebook
        </h1>
        <p style={{ fontSize: '14px', color: MUTED, margin: '0 0 24px', lineHeight: 1.6 }}>
          Get your business in front of every guest staying nearby — featured in their
          digital guidebook for $15/month.
        </p>

        {success && (
          <Banner color={GREEN} text="Subscription started! Your listing will appear in the guidebook shortly." />
        )}
        {cancelled && (
          <Banner color={MUTED} text="Checkout cancelled — you can try again anytime." />
        )}
        {error && <Banner color={RED} text={error} />}

        <div
          style={{
            background: CARD, border: `1px solid ${BORDER}`, borderRadius: '12px',
            padding: '20px', marginBottom: '24px',
          }}
        >
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 4px' }}>
            {sponsor.business_name}
          </h2>

          {sponsor.business_description && (
            <p style={{ fontSize: '13px', color: MUTED, margin: '0 0 12px', lineHeight: 1.5 }}>
              {sponsor.business_description}
            </p>
          )}
          {sponsor.custom_offer_text && (
            <p style={{ fontSize: '13px', color: GOLD, margin: '0 0 8px', fontWeight: 600 }}>
              {sponsor.custom_offer_text}
            </p>
          )}
          {sponsor.address && (
            <p style={{ fontSize: '13px', color: MUTED, margin: 0 }}>{sponsor.address}</p>
          )}
        </div>

        {isActive ? (
          <Banner color={GREEN} text="This sponsorship is active. Thanks for supporting local guests!" />
        ) : (
          <button
            onClick={handleCheckout}
            disabled={isLoading}
            style={{
              width: '100%', padding: '14px', borderRadius: '8px', border: 'none',
              background: GOLD, color: CHARCOAL, fontSize: '15px', fontWeight: 700,
              cursor: isLoading ? 'default' : 'pointer', opacity: isLoading ? 0.6 : 1,
            }}
          >
            {isLoading ? 'Redirecting…' : 'Subscribe — $15/month'}
          </button>
        )}
      </div>
    </div>
  )
}

function Banner({ color, text }: Readonly<{ color: string; text: string }>) {
  return (
    <div
      style={{
        border: `1px solid ${color}`, borderRadius: '8px', padding: '12px 14px',
        marginBottom: '16px', fontSize: '13px', color,
      }}
    >
      {text}
    </div>
  )
}
