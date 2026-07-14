// Matches the guest-facing "ticket" visual language established in
// components/guidebook/guest-guidebook-view.tsx (charcoal/gold, inline hex —
// this route tree does not use the app's --bg-card / -themed CSS-variable
// convention, so we mirror its actual constants here instead).
const CHARCOAL = '#0E0E0E'
const CARD     = '#17171A'
const BORDER   = '#2A2A2E'

export default function Loading() {
  return (
    <div style={{ minHeight: '100vh', background: CHARCOAL, padding: '24px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto' }} className="animate-pulse">
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: '20px', overflow: 'hidden' }}>
          <div style={{ height: '160px', background: BORDER }} />
          <div style={{ padding: '24px' }}>
            <div style={{ height: '14px', width: '40%', background: BORDER, borderRadius: '4px', marginBottom: '12px' }} />
            <div style={{ height: '24px', width: '70%', background: BORDER, borderRadius: '4px', marginBottom: '20px' }} />
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ height: '64px', flex: 1, background: BORDER, borderRadius: '12px' }} />
              <div style={{ height: '64px', flex: 1, background: BORDER, borderRadius: '12px' }} />
            </div>
          </div>
        </div>

        <div style={{ marginTop: '20px' }}>
          <div style={{ height: '80px', background: CARD, border: `1px solid ${BORDER}`, borderRadius: '16px' }} />
        </div>
      </div>
    </div>
  )
}
