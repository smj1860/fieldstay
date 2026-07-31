// Server Component — deliberately NOT 'use client'.
//
// Pre-launch audit 2026-07-30, M1 (isolation): the "Guidebook Coming Soon"
// placeholder used to be an early return INSIDE the client component
// GuestGuidebookView, which meant app/g/[slug]/page.tsx had already passed the
// full guidebook_property_configs row — wifi_network, wifi_password,
// check_in_instructions, house_rules — to a 'use client' boundary before
// anything decided the guidebook was unpublished. Those props are serialized
// into the RSC flight payload and are readable in page source, so an
// unpublished (or org-deactivated) guidebook's door codes and wifi password
// were retrievable by anyone who knew the slug.
//
// The gate is now server-side: the page returns THIS component and never
// constructs the client component's props at all. Keep this a server
// component — the whole point is that no property data crosses the boundary.

const CHARCOAL = '#0E0E0E'
const TEXT     = '#F4F4F5'
const MUTED    = '#9A9AA2'

export function GuidebookUnavailable() {
  return (
    <div style={{
      minHeight:      '100vh',
      background:     CHARCOAL,
      color:          TEXT,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      padding:        '24px',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '420px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>Guidebook Coming Soon</h1>
        <p style={{ fontSize: '14px', color: MUTED, lineHeight: 1.6 }}>
          This property&apos;s digital guidebook isn&apos;t quite ready yet. Please check back soon,
          or contact your host directly for check-in details.
        </p>
      </div>
    </div>
  )
}
