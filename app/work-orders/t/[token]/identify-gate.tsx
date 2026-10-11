'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserCheck } from 'lucide-react'

/**
 * The first screen a technician sees on a forwarded work order.
 *
 * WHY THE NAME IS REQUIRED HERE. It becomes the attribution on every write
 * they make, replacing the free-text "who completed this work" typed at the end
 * of the completion form, which nothing verified and nobody could revoke. It
 * also becomes the vendor's roster label, so the next job is a pick-list entry
 * instead of another link to create by hand.
 *
 * WHY THE MOBILE IS OPTIONAL, AND THEIRS TO GIVE. The alternative was the
 * vendor typing it at send time, which means typos in a roster keyed on the
 * phone number and an employer handing over an employee's mobile. Asked here,
 * the number arrives with its owner's own consent and the vendor never types
 * one.
 *
 * AND WHY THE JOB IS NOT RENDERED BEHIND IT. `work_orders` carries
 * `lockbox_code`, `access_notes` and `parking_notes`. A link pasted into the
 * wrong thread must not hand a stranger a door code, so the gate comes first
 * and the identification is what produces the audit row naming who saw it.
 */
export function IdentifyGate({
  token,
  woNumber,
  propertyName,
  jobTitle,
}: Readonly<{
  token:        string
  woNumber:     string | null
  propertyName: string | null
  jobTitle:     string
}>) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/work-orders/t/${token}/identify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), phone: phone.trim() || null }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof payload.error === 'string' ? payload.error : 'Something went wrong. Please try again.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not reach FieldStay. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: '#1A1A1A',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    }}>
      <div style={{
        backgroundColor: '#ffffff', borderRadius: 16, width: '100%', maxWidth: 420,
        overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          backgroundColor: '#1A1A1A', borderBottom: '3px solid #FF6B00', padding: '20px 24px',
        }}>
          <p style={{ color: '#FF6B00', fontSize: 16, fontWeight: 800, margin: 0 }}>TradeSuite</p>
          <p style={{ color: '#C0C0C0', fontSize: 10, margin: '2px 0 0', letterSpacing: '0.1em' }}>
            POWERED BY FIELDSTAY
          </p>
        </div>

        <form onSubmit={submit} style={{ padding: 24 }}>
          {/* Enough to confirm they have the right job, and nothing that would
              matter if this link reached the wrong phone: no address, no
              lockbox code, no access notes. */}
          <p style={{ fontSize: 15, fontWeight: 700, color: '#1A1A1A', margin: '0 0 4px' }}>
            {jobTitle}
          </p>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
            {[woNumber, propertyName].filter(Boolean).join(' at ') || 'Work order'}
          </p>

          {error && (
            <div style={{
              backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
              padding: '10px 12px', marginBottom: 14, fontSize: 13, color: '#b91c1c',
            }}>
              {error}
            </div>
          )}

          <label htmlFor="tech-name" style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Your name <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            id="tech-name"
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="So the work is recorded under it"
            style={{
              width: '100%', fontSize: 14, padding: '11px 12px', marginBottom: 16,
              border: '1px solid #d1d5db', borderRadius: 8, color: '#374151',
              boxSizing: 'border-box',
            }}
          />

          <label htmlFor="tech-phone" style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Your mobile
            <span style={{ fontWeight: 400, color: '#94a3b8' }}> (optional)</span>
          </label>
          <input
            id="tech-phone"
            type="tel"
            inputMode="tel"
            maxLength={32}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(334) 555-1212"
            style={{
              width: '100%', fontSize: 14, padding: '11px 12px', marginBottom: 6,
              border: '1px solid #d1d5db', borderRadius: 8, color: '#374151',
              boxSizing: 'border-box',
            }}
          />
          <p style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, margin: '0 0 20px' }}>
            Only so future jobs can be sent straight to you. Leave it blank and
            nothing changes.
          </p>

          <button
            type="submit"
            disabled={busy || !name.trim()}
            style={{
              width: '100%', padding: 13, borderRadius: 10, border: 'none',
              backgroundColor: busy || !name.trim() ? '#d1d5db' : '#FF6B00',
              color: '#ffffff', fontSize: 15, fontWeight: 700,
              cursor: busy || !name.trim() ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {busy
              ? <><Loader2 style={{ width: 16, height: 16 }} /> Opening</>
              : <><UserCheck style={{ width: 16, height: 16 }} /> Open this job</>}
          </button>
        </form>
      </div>
    </div>
  )
}
