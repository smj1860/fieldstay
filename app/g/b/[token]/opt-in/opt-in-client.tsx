'use client'

import { useState } from 'react'
import { optInGuestSms } from '@/app/actions/guidebook'

const CHARCOAL = '#0E0E0E'
const CARD     = '#17171A'
const BORDER   = '#2A2A2E'
const TEXT     = '#F4F4F5'
const MUTED    = '#9A9AA2'
const GOLD     = '#D4A537'

export function OptInClient({ token, propertyName }: Readonly<{ token: string; propertyName: string }>) {
  const [phone, setPhone] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    const result = await optInGuestSms(token, phone)

    if ('error' in result) {
      setError(result.error)
      setStatus('error')
      return
    }

    setStatus('success')
  }

  return (
    <div style={{ minHeight: '100vh', background: CHARCOAL, color: TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ maxWidth: '420px', width: '100%' }}>
        {status === 'success' ? (
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>You&apos;re all set!</h1>
            <p style={{ fontSize: '14px', color: MUTED, lineHeight: 1.6 }}>
              We&apos;ll text your door code to your phone shortly. Reply STOP at any
              time to opt out.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
              Get your door code by text
            </h1>
            <p style={{ fontSize: '14px', color: MUTED, margin: '0 0 20px', lineHeight: 1.6 }}>
              Enter your phone number and we&apos;ll text your door code for{' '}
              {propertyName}, plus helpful updates during your stay.
            </p>
            <input
              type="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-5555"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: '10px',
                border: `1px solid ${BORDER}`, background: CARD, color: TEXT,
                fontSize: '15px', marginBottom: '12px', boxSizing: 'border-box',
              }}
            />
            {error && (
              <p style={{ color: '#f87171', fontSize: '13px', margin: '0 0 12px' }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={status === 'submitting'}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', border: 'none',
                background: GOLD, color: CHARCOAL, fontWeight: 700, fontSize: '15px',
                cursor: status === 'submitting' ? 'default' : 'pointer',
              }}
            >
              {status === 'submitting' ? 'Sending...' : 'Text Me My Door Code'}
            </button>
            <p style={{ fontSize: '11px', color: MUTED, margin: '12px 0 0', lineHeight: 1.5 }}>
              By submitting, you consent to receive automated text messages.
              Msg &amp; data rates may apply. Reply STOP to opt out.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
