import { Key, LogOut, Wifi, ClipboardList, Sun, CloudRain, Snowflake, Thermometer, CloudSun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { GuidebookSponsor, GuidebookPropertyConfig, Property } from '@/types/database'
import type { WeatherContext } from '@/lib/weather/tomorrow'
import { getActiveSlotTypes, getTimeOfDay } from '@/lib/weather/tomorrow'
import { formatOffer } from '@/lib/sms/telnyx'
import { CopyButton } from './copy-button'
import styles from './guest-guidebook-view.module.css'

const CHARCOAL = '#0E0E0E'
const CARD     = '#17171A'
const BORDER   = '#2A2A2E'
const TEXT     = '#F4F4F5'
const MUTED    = '#9A9AA2'
const GOLD     = '#D4A537'

const TIME_OF_DAY_GLOW: Record<'morning' | 'daytime' | 'evening', { glow: string; glow2: string }> = {
  morning: { glow: 'rgba(212,165,55,0.20)', glow2: 'rgba(212,165,55,0.06)' },
  daytime: { glow: 'rgba(212,165,55,0.30)', glow2: 'rgba(212,165,55,0.12)' },
  evening: { glow: 'rgba(212,165,55,0.24)', glow2: 'rgba(212,165,55,0.10)' },
}

function formatTime12h(time: string | null | undefined): string | null {
  if (!time) return null
  const [hourStr, minuteStr] = time.split(':')
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  const period = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`
}

function WeatherIcon({ weather }: Readonly<{ weather: WeatherContext }>) {
  if (weather.isSnowy) return <Snowflake className="w-3.5 h-3.5" />
  if (weather.isRainy) return <CloudRain className="w-3.5 h-3.5" />
  if (weather.isCold)  return <Thermometer className="w-3.5 h-3.5" />
  if (weather.isHot)   return <Sun className="w-3.5 h-3.5" />
  return <CloudSun className="w-3.5 h-3.5" />
}

interface ExtensionRequestProp {
  id:                   string
  gap_days:             number
  discount_pct:         number | null
  next_booking_checkin: string | null
  status:               string
}

interface ExtensionConfigProp {
  extension_contact_method: 'ownerrez_url' | 'email' | 'sms' | null
  extension_ownerrez_url:   string | null
}

interface GuestGuidebookViewProps {
  property:         Property
  config:           GuidebookPropertyConfig
  sponsors:         GuidebookSponsor[]
  isActive:         boolean
  hourOfDay:        number
  weather:          WeatherContext | null
  extensionRequest?: ExtensionRequestProp | null
  extensionConfig?:  ExtensionConfigProp | null
}

export function GuestGuidebookView({
  property,
  config,
  sponsors,
  isActive,
  hourOfDay,
  weather,
  extensionRequest = null,
  extensionConfig = null,
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

  const weatherLabel = weather
    ? weather.isSnowy
      ? 'Snowy'
      : weather.isRainy
        ? 'Rainy'
        : weather.isCold
          ? 'Cold'
          : weather.isHot
            ? 'Hot'
            : 'Mild weather'
    : ''

  const checkInTime = formatTime12h(property.checkin_time)
  const checkOutTime = formatTime12h(property.checkout_time)

  return (
    <div style={{ minHeight: '100vh', background: CHARCOAL, color: TEXT, padding: '24px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        <div
          className={styles.ticketWrap}
          style={{ '--gold': GOLD, '--border': BORDER, '--charcoal': CHARCOAL } as React.CSSProperties}
        >
          <div
            className={styles.ticket}
            style={{
              background: CARD,
              border: '1px solid rgba(212,165,55,0.38)',
              ...({ '--glow': TIME_OF_DAY_GLOW[timeOfDay].glow, '--glow2': TIME_OF_DAY_GLOW[timeOfDay].glow2 } as React.CSSProperties),
            }}
          >
            <div className={`${styles.ticketTop} ${styles.grain}`}>
              <div className={styles.glow} />
              <div className={styles.ticketTopContent}>
                <div className={styles.eyebrowRow}>
                  <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: GOLD, margin: 0 }}>
                    Your stay at
                  </p>
                  {weather && (
                    <div className={styles.weatherChip} style={{ color: MUTED }}>
                      <span style={{ color: GOLD }} role="img" aria-label={weatherLabel}><WeatherIcon weather={weather} /></span>
                      <span>
                        {Math.round(weather.temperature)}°F
                        {weather.isSnowy ? ', snow' : weather.isRainy ? ', rain likely' : ''}
                      </span>
                    </div>
                  )}
                </div>
                <h1 style={{ fontFamily: 'var(--font-syne)', fontWeight: 800, fontSize: '30px', lineHeight: 1.08, letterSpacing: '-0.01em', margin: '0 0 4px', textShadow: '0 2px 16px rgba(0,0,0,0.5)' }}>
                  {property.name}
                </h1>
                <p style={{ fontSize: '13px', color: MUTED, margin: 0, textTransform: 'capitalize' }}>
                  Good {timeOfDay}
                </p>
              </div>
            </div>

            <div className={styles.seam}>
              <span className={`${styles.notch} ${styles.notchLeft}`} />
              <span className={`${styles.notch} ${styles.notchRight}`} />
            </div>

            <div className={styles.ticketBottom}>
              {checkInTime && (
                <div className={styles.stub}>
                  <p className={styles.stubLabel} style={{ color: MUTED }}>
                    <Key style={{ color: GOLD }} /> Check-in
                  </p>
                  <p className={styles.stubValue} style={{ color: TEXT }}>{checkInTime}</p>
                </div>
              )}
              {checkOutTime && (
                <div className={styles.stub}>
                  <p className={styles.stubLabel} style={{ color: MUTED }}>
                    <LogOut style={{ color: GOLD }} /> Check-out
                  </p>
                  <p className={styles.stubValue} style={{ color: TEXT }}>{checkOutTime}</p>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Phase 2 (not yet built): once a property hero image exists, it renders
            as the background of .ticketTop in place of the CARD color set above,
            with .glow dimmed rather than removed. */}

        <Section title="Check-In" icon={Key}>
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '14px' }}>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap', margin: 0 }}>
              {config.check_in_instructions ?? 'Check-in details coming soon.'}
            </p>
          </div>
        </Section>

        <Section title="Wifi" icon={Wifi}>
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <p style={{ fontSize: '14px', color: TEXT, margin: 0 }}>
                Network: {config.wifi_network ?? 'See welcome book'}
              </p>
              {config.wifi_network && <CopyButton value={config.wifi_network} label="wifi network" />}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <p style={{ fontSize: '14px', color: TEXT, margin: 0 }}>
                Password: {config.wifi_password ?? 'See welcome book'}
              </p>
              {config.wifi_password && <CopyButton value={config.wifi_password} label="wifi password" />}
            </div>
          </div>
        </Section>

        {visibleSponsors.length > 0 && (
          <Section title="Recommended Nearby">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {visibleSponsors.map((sponsor) => {
                const offerLine = formatOffer(
                  sponsor.offer_type,
                  sponsor.offer_value,
                  sponsor.offer_item,
                  sponsor.custom_offer_text
                )

                return (
                  <div
                    key={sponsor.id}
                    className={styles.sponsorCard}
                    style={{ background: CARD, border: `1px solid ${BORDER}`, overflow: 'hidden' }}
                  >
                    <div style={{ padding: '14px' }}>
                      <h3 className={styles.sponsorName}>
                        {sponsor.business_name}
                      </h3>
                      {sponsor.business_description && (
                        <p style={{ fontSize: '13px', color: MUTED, margin: '0 0 8px', lineHeight: 1.5 }}>
                          {sponsor.business_description}
                        </p>
                      )}
                      {offerLine && (
                        <div className={styles.offerBadge} style={{ background: 'rgba(212,165,55,0.14)', border: '1px solid rgba(212,165,55,0.4)' }}>
                          <p style={{ fontSize: '10px', color: GOLD, fontWeight: 700, letterSpacing: '0.06em', margin: '0 0 2px' }}>
                            GUIDEBOOK EXCLUSIVE
                          </p>
                          <p style={{ fontSize: '13px', color: GOLD, fontWeight: 600, margin: 0 }}>
                            {offerLine}
                          </p>
                        </div>
                      )}
                      {sponsor.address && (
                        <p style={{ fontSize: '12px', color: MUTED, margin: 0 }}>{sponsor.address}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        {config.house_rules && (
          <Section title="House Rules" icon={ClipboardList}>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap' }}>
              {config.house_rules}
            </p>
          </Section>
        )}

        <Section title="Check-Out" icon={LogOut}>
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '14px' }}>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: TEXT, whiteSpace: 'pre-wrap', margin: 0 }}>
              {config.check_out_instructions ?? 'Check-out details coming soon.'}
            </p>
          </div>
        </Section>

        {extensionRequest && extensionConfig && (
          <div style={{
            margin: '16px 0',
            border: `1.5px solid ${GOLD}`,
            borderRadius: 12,
            padding: '16px',
            background: CARD,
          }}>
            <p style={{ color: GOLD, fontSize: 11, fontWeight: 700,
                        letterSpacing: 1.5, textTransform: 'uppercase', margin: '0 0 6px' }}>
              Extend Your Stay
            </p>
            <p style={{ color: TEXT, fontSize: 14, margin: '0 0 12px', lineHeight: 1.5 }}>
              {extensionRequest.gap_days} night{extensionRequest.gap_days !== 1 ? 's' : ''} available
              after your checkout{extensionRequest.discount_pct
                ? ` — ${extensionRequest.discount_pct}% off if you book now`
                : ''}.
            </p>
            {extensionConfig.extension_contact_method === 'ownerrez_url' && extensionConfig.extension_ownerrez_url ? (
              <a
                href={extensionConfig.extension_ownerrez_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: '44px',
                  background: GOLD, color: CHARCOAL,
                  fontWeight: 700, fontSize: 14,
                  padding: '0 20px', borderRadius: 8,
                  textDecoration: 'none',
                }}
              >
                Check Availability →
              </a>
            ) : (
              <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
                Reply to our text message or contact your host directly to extend.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, icon: Icon, children }: Readonly<{ title: string; icon?: LucideIcon; children: React.ReactNode }>) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <div className={styles.sectionHead}>
        {Icon && (
          <span className={styles.iconBadge} style={{ background: 'rgba(212,165,55,0.14)', border: `1px solid ${BORDER}` }}>
            <Icon style={{ color: GOLD }} />
          </span>
        )}
        <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: TEXT, margin: 0, whiteSpace: 'nowrap' }}>
          {title}
        </p>
        <span className={styles.headLine} style={{ background: `linear-gradient(to right, ${BORDER}, transparent)` }} />
      </div>
      {children}
    </div>
  )
}
