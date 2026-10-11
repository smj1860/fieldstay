import { Clock } from 'lucide-react'

/**
 * The screen for a link that has run out, or a technician grant that was
 * revoked.
 *
 * ITS OWN COMPONENT because both portal pages render it and neither can reach
 * the work order to render the full shell: an expired token resolves to no work
 * order at all. The previous page carried this as a boolean prop on a
 * fully-loaded portal, which only worked while the page read the row before
 * checking expiry.
 *
 * It names no property, no job and no vendor. An expired link is still a link
 * somebody may have forwarded to the wrong person, so this is the one screen
 * that must say nothing about what it used to open.
 *
 * Styled inline to match the TradeSuite shell, which is branded separately
 * from the dashboard and is delivered this way so it renders identically in
 * whatever browser a dispatch email opens in.
 */
export function ExpiredPortal() {
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

        <div style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <Clock style={{ width: 36, height: 36, color: '#64748b' }} />
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>
            This link is no longer active
          </h2>
          <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6, margin: 0 }}>
            Contact the property manager for a new one.
          </p>
        </div>
      </div>
    </div>
  )
}
