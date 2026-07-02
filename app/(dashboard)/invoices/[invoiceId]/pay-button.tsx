'use client'

import { useState } from 'react'

export function PayInvoiceButton({
  invoiceId,
  total,
}: Readonly<{
  invoiceId: string
  total:     number
}>) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const fmt = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  async function handlePay() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/checkout`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.url) {
        setError(data.error ?? 'Could not create checkout session. Try again.')
        return
      }
      window.location.href = data.url
    } catch {
      setError('Network error. Please check your connection.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {error && (
        <div style={{
          backgroundColor: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 8, padding: '10px 14px', marginBottom: 12,
          fontSize: 13, color: '#b91c1c',
        }}>
          {error}
        </div>
      )}
      <button
        onClick={handlePay}
        disabled={loading}
        style={{
          width:           '100%',
          backgroundColor: loading ? '#d1d5db' : '#FF6B00',
          color:           '#ffffff',
          border:          'none',
          borderRadius:    12,
          padding:         '16px',
          fontSize:        16,
          fontWeight:      700,
          cursor:          loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Opening payment…' : `Pay ${fmt(total)} via Stripe`}
      </button>
    </div>
  )
}
