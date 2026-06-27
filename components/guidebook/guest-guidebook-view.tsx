import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'
import type { WeatherContext } from '@/lib/weather/tomorrow'
import { getActiveSlotTypes, getTimeOfDay } from '@/lib/weather/tomorrow'

const CHARCOAL = '#0E0E0E'
const CARD     = '#17171A'
const BORDER   = '#2A2A2E'
const TEXT     = '#F4F4F5'
const MUTED    = '#9A9AA2'
const GOLD     = '#D4A537'

interface GuestGuidebookViewProps {
  property:    Property
  config:      GuidebookPropertyConfig
  sponsors:    GuidebookSponsor[]
  isActive:    boolean
  hourOfDay:   number
  weather:     WeatherContext | null
}

export function GuestGuidebookView({
  property,
  config,
  sponsors,
  isActive,
  hourOfDay,
  weather,
}: GuestGuidebookViewProps) {
  if (!isActive) {
    return (
      <div style={{ minHeight: '100vh', background: CHARCOAL, color: TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
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

  const activeSlots = weather
    ? getActiveSlotTypes(hourOfDay, weather)
    : new Set(['general', 'other'])

  const timeOfDay = getTimeOfDay(hourOfDay)

  const visibleSponsors = sponsors
    .filter((s) => s.status === 'active')
    .filter((s) => activeSlots.has(s.slot_type))

  return (
    <div style={{ minHeight: '100vh', background: CHARCOAL, color: TEXT, padding: '24px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>{property.name}</h1>
        <p style={{ fontSize: '13px', color: MUTED, margin: '0 0 12px', textTransform: 'capitalize' }}>
          Good {timeOfDay}
        </p>

        {weather && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#1e293b', borderRadius: '999px', padding: '6px 14px', marginBottom: '24px' }}>
            <span style={{ fontSize: '16px' }}>
              {weather.isSnowy ? '❄️' : weather.isRainy ? '🌧️' : weather.isCold ? '🧥' : weather.isHot ? '☀️' : '🌤️'}
            </span>
            <span style={{ color: '#94a3b8', fontSize: '13px', fontWeight: '500' }}>
              {Math.round(weather.temperature)}°F · Feels {Math.round(weather.temperatureApparent)}°F
              {weather.isSnowy ? ' · Snow' : weather.isRainy ? ' · Rain likely' : ''}
            </span>
          </div>
        )}

        <Section title="Check-In">
          <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap' }}>
            {config.check_in_instructions ?? 'Check-in details coming soon.'}
          </p>
        </Section>

        <Section title="Wifi">
          <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT }}>
            Network: {config.wifi_network ?? 'See welcome book'}<br />
            Password: {config.wifi_password ?? 'See welcome book'}
          </p>
        </Section>

        {config.house_rules && (
          <Section title="House Rules">
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap' }}>
              {config.house_rules}
            </p>
          </Section>
        )}

        <Section title="Check-Out">
          <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap' }}>
            {config.check_out_instructions ?? 'Check-out details coming soon.'}
          </p>
        </Section>

        {visibleSponsors.length > 0 && (
          <Section title="Recommended Nearby">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {visibleSponsors.map((sponsor) => (
                <div
                  key={sponsor.id}
                  style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '14px' }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 4px' }}>
                    {sponsor.business_name}
                  </h3>
                  {sponsor.business_description && (
                    <p style={{ fontSize: '13px', color: MUTED, margin: '0 0 8px', lineHeight: 1.5 }}>
                      {sponsor.business_description}
                    </p>
                  )}
                  {sponsor.custom_offer_text && (
                    <p style={{ fontSize: '13px', color: GOLD, fontWeight: 600, margin: '0 0 4px' }}>
                      {sponsor.custom_offer_text}
                    </p>
                  )}
                  {sponsor.address && (
                    <p style={{ fontSize: '12px', color: MUTED, margin: 0 }}>{sponsor.address}</p>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '12px', fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>
        {title}
      </h2>
      {children}
    </div>
  )
}
