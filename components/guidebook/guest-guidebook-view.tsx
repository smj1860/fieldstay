'use client'

import { useEffect, useState } from 'react'
import { Wifi, MapPin, Key, Sun, CloudRain, Snowflake, Thermometer, CloudSun } from 'lucide-react'
import type { Property, GuidebookPropertyConfig, GuidebookSlotType, GuidebookOfferType } from '@/types/database'
import type { WeatherContext } from '@/lib/weather/tomorrow'
import { getActiveSlotTypes, getTimeOfDay } from '@/lib/weather/tomorrow'
import { formatOffer } from '@/lib/guidebook/offer'
import { CopyButton } from './copy-button'
import styles from './guest-guidebook-view.module.css'
import { formatTime12h } from '@/lib/utils/time-of-day'

const CHARCOAL = '#0E0E10'
const CARD     = '#17171A'
const CARD2    = '#1D1D21'
const BORDER   = '#2A2A2E'
const TEXT     = '#F4F4F5'
const MUTED    = '#9A9AA2'
const GOLD     = '#D4A537'

type SkyState = 'morning' | 'daytime' | 'evening' | 'checkout'
type EffectivePhase = 'arrival' | 'mid' | 'checkout'

const GREETING: Record<SkyState, string> = {
  morning:  'Good morning ☕',
  daytime:  'Good afternoon ☀️',
  evening:  'Good evening 🌇',
  checkout: 'Checkout day 👋',
}

const SLOT_EMOJI: Record<GuidebookSlotType, string> = {
  morning_brew:      '☕',
  dinner_pints:      '🍽️',
  rainy_day:         '☔',
  outdoor_adventure: '🚤',
  general:           '📍',
  other:             '📍',
}

const WHY_CHIP: Record<GuidebookSlotType, string> = {
  morning_brew:      'Cold morning pick',
  dinner_pints:      "Tonight's dinner pick",
  rainy_day:         'Rainy day pick',
  outdoor_adventure: "Today's pick",
  general:           "Today's pick",
  other:             "Today's pick",
}

function formatClock(d: Date): string {
  let hour = d.getHours()
  const minute = d.getMinutes().toString().padStart(2, '0')
  const second = d.getSeconds().toString().padStart(2, '0')
  const period = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12 === 0 ? 12 : hour % 12
  return `${hour}:${minute}:${second} ${period}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

// Haversine distance, converted to a rough drive-time estimate at 30 mph.
// Only called when all four coordinates exist — never renders a guessed number.
function haversineMinutes(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8 // miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return Math.round(((R * c) / 30) * 60)
}

function sponsorDistanceMinutes(property: Property, sponsor: GuidebookSponsorView): number | null {
  if (property.lat == null || property.lng == null || sponsor.lat == null || sponsor.lng == null) return null
  return haversineMinutes(property.lat, property.lng, sponsor.lat, sponsor.lng)
}

function sponsorDirectionsUrl(sponsor: GuidebookSponsorView): string | null {
  if (sponsor.lat != null && sponsor.lng != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${sponsor.lat},${sponsor.lng}`
  }
  if (sponsor.address) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(sponsor.address)}`
  }
  return null
}

function propertyDirectionsUrl(property: Property): string | null {
  return property.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(property.address)}`
    : null
}

function getSkyState(hourOfDay: number, phase: EffectivePhase): SkyState {
  return phase === 'checkout' ? 'checkout' : getTimeOfDay(hourOfDay)
}

function pickHeroSponsor(
  visibleSponsors: GuidebookSponsorView[],
  hourOfDay: number,
  weather: WeatherContext | null
): GuidebookSponsorView | null {
  const bySlot = (slot: GuidebookSlotType) => visibleSponsors.find((s) => s.slot_type === slot) ?? null

  if (hourOfDay >= 7 && hourOfDay < 11) {
    const s = bySlot('morning_brew')
    if (s) return s
  }
  if (hourOfDay >= 17) {
    const s = bySlot('dinner_pints')
    if (s) return s
  }
  if (weather?.isRainy || weather?.isSnowy) {
    const s = bySlot('rainy_day')
    if (s) return s
  }
  const outdoor = bySlot('outdoor_adventure')
  if (outdoor) return outdoor

  return visibleSponsors[0] ?? null
}

function pickCheckoutSponsor(visibleSponsors: GuidebookSponsorView[]): GuidebookSponsorView | null {
  return visibleSponsors.find((s) => s.slot_type === 'morning_brew') ?? visibleSponsors[0] ?? null
}

function buildMomentLine(params: {
  skyState:        SkyState
  weather:         WeatherContext | null
  heroSponsor:     GuidebookSponsorView | null
  distanceMinutes: number | null
  checkOutTime:    string | null
}): string {
  const { skyState, weather, heroSponsor, distanceMinutes, checkOutTime } = params

  if (skyState === 'morning' && weather?.isCold && heroSponsor?.slot_type === 'morning_brew') {
    return distanceMinutes !== null
      ? `Chilly one out there — coffee's ${distanceMinutes} minutes away.`
      : "Chilly one out there — coffee's nearby."
  }

  switch (skyState) {
    case 'evening':
      return 'Perfect night to eat out — dinner ideas below.'
    case 'checkout':
      return checkOutTime
        ? `Checkout is at ${checkOutTime}. Here's your quick list.`
        : "Here's your quick list before you go."
    case 'daytime':
      return "Good afternoon — here's your stay at a glance."
    case 'morning':
    default:
      return "Good morning — here's your stay at a glance."
  }
}

function parseChecklistItems(text: string | null): string[] {
  if (!text) return []
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, ''))
}

function WeatherIcon({ weather }: Readonly<{ weather: WeatherContext }>) {
  if (weather.isSnowy) return <Snowflake />
  if (weather.isRainy) return <CloudRain />
  if (weather.isCold)  return <Thermometer />
  if (weather.isHot)   return <Sun />
  return <CloudSun />
}

interface ExtensionRequestProp {
  id:                   string
  gap_days:             number
  discount_pct:         number | null
  next_booking_checkin: string | null
  status:               string
}

export const EXTENSION_CONTACT_METHODS = ['ownerrez_url', 'email', 'sms'] as const
export type ExtensionContactMethod = (typeof EXTENSION_CONTACT_METHODS)[number]

/**
 * guidebook_configurations.extension_contact_method is TEXT, not a Postgres
 * enum, so the column can hold any string — this is the boundary that turns it
 * into the union the UI branches on. Returns null for absent/unrecognized so
 * each caller decides whether to fall back to the column's default ('email').
 */
export function asExtensionContactMethod(
  value: string | null | undefined,
): ExtensionContactMethod | null {
  for (const method of EXTENSION_CONTACT_METHODS) {
    if (method === value) return method
  }
  return null
}

interface ExtensionConfigProp {
  extension_contact_method: ExtensionContactMethod | null
  extension_ownerrez_url:   string | null
}

export interface GuidebookSponsorView {
  id:                    string
  slot_type:             GuidebookSlotType
  business_name:         string
  business_description:  string | null
  custom_offer_text:     string | null
  offer_type:            GuidebookOfferType
  offer_value:            number | null
  offer_item:            string | null
  featured_item:         string | null
  address:               string | null
  business_phone:        string | null
  business_website:      string | null
  lat:                   number | null
  lng:                   number | null
  photoUrl:              string | null
}

interface StayInfo {
  phase:       EffectivePhase
  nightIndex:  number
  totalNights: number
}

interface GuestGuidebookViewProps {
  property:          Property
  config:            GuidebookPropertyConfig
  sponsors:          GuidebookSponsorView[]
  // NOTE: there is deliberately no `isActive` prop. The published/active gate
  // is enforced on the SERVER (app/g/[slug]/page.tsx, app/g/b/[token]/page.tsx
  // return <GuidebookUnavailable /> instead of rendering this component). It
  // used to be an early return in here, which meant the config — wifi_password,
  // check_in_instructions, house_rules — had already been serialized across the
  // client boundary into the page's flight payload before the check ran. Do not
  // reintroduce a client-side visibility gate: by the time this component can
  // evaluate one, the data has already shipped.
  hourOfDay:         number
  weather:           WeatherContext | null
  heroPhotoUrl:      string | null
  stay:              StayInfo | null
  bookingToken:      string | null
  extensionRequest?: ExtensionRequestProp | null
  extensionConfig?:  ExtensionConfigProp | null
}

export function GuestGuidebookView({
  property,
  config,
  sponsors,
  hourOfDay,
  weather,
  heroPhotoUrl,
  stay,
  bookingToken,
  extensionRequest = null,
  extensionConfig = null,
}: Readonly<GuestGuidebookViewProps>) {
  const [wifiOpen, setWifiOpen] = useState(false)
  const [pass, setPass] = useState<{ sponsorId: string; businessName: string; offerLine: string } | null>(null)

  const activeSlots = weather ? getActiveSlotTypes(hourOfDay, weather) : new Set(['general', 'other'])
  const visibleSponsors = sponsors.filter((s) => activeSlots.has(s.slot_type))

  const effectivePhase: EffectivePhase = stay ? stay.phase : hourOfDay < 12 ? 'arrival' : 'mid'
  const skyState = getSkyState(hourOfDay, effectivePhase)
  const checkOutTime = formatTime12h(property.checkout_time)

  const heroSponsor = effectivePhase === 'checkout'
    ? null
    : pickHeroSponsor(visibleSponsors, hourOfDay, weather)
  const secondarySponsors = visibleSponsors.filter((s) => s.id !== heroSponsor?.id)
  const heroDistance = heroSponsor ? sponsorDistanceMinutes(property, heroSponsor) : null

  const momentLine = buildMomentLine({
    skyState, weather, heroSponsor, distanceMinutes: heroDistance, checkOutTime,
  })

  function scrollToCheckSection() {
    const id = effectivePhase === 'checkout' ? 'gb-checkout-section' : 'gb-checkin-section'
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  function openPass(sponsor: GuidebookSponsorView, offerLine: string) {
    setPass({ sponsorId: sponsor.id, businessName: sponsor.business_name, offerLine })
  }

  return (
    <div
      className={styles.frame}
      style={{
        background: CHARCOAL, color: TEXT,
        ...({
          '--charcoal': CHARCOAL, '--card': CARD, '--card2': CARD2,
          '--border': BORDER, '--text': TEXT, '--muted': MUTED, '--gold': GOLD,
        } as React.CSSProperties),
      }}
    >
      <div className={`${styles.sky} ${styles[`sky_${skyState}`]}`}>
        <div className={`${styles.sun} ${styles[`sun_${skyState}`]}`} />
        <SkyMoment skyState={skyState} weather={weather} momentLine={momentLine} />
        <PropertyTicket property={property} heroPhotoUrl={heroPhotoUrl} stay={stay} />
      </div>

      <div className={styles.seam}>
        <span className={`${styles.notch} ${styles.notchLeft}`} />
        <span className={`${styles.notch} ${styles.notchRight}`} />
      </div>

      <QuickActionsRow
        wifiOpen={wifiOpen}
        onToggleWifi={() => setWifiOpen((v) => !v)}
        directionsUrl={propertyDirectionsUrl(property)}
        onScrollToCheckSection={scrollToCheckSection}
        checkoutPhase={effectivePhase === 'checkout'}
      />

      <div className={styles.content}>
        {wifiOpen && (
          <div className={styles.wifiPanel}>
            <div className={styles.wifiRow}>
              <span className={styles.wifiK}>Network</span>
              <span className={styles.wifiV}>{config.wifi_network ?? 'See welcome book'}</span>
              {config.wifi_network && <CopyButton value={config.wifi_network} label="wifi network" />}
            </div>
            <div className={styles.wifiRow}>
              <span className={styles.wifiK}>Password</span>
              <span className={styles.wifiV}>{config.wifi_password ?? 'See welcome book'}</span>
              {config.wifi_password && <CopyButton value={config.wifi_password} label="wifi password" />}
            </div>
          </div>
        )}

        {effectivePhase === 'checkout' && (
          <CheckoutPhaseContent
            config={config}
            checkOutTime={checkOutTime}
            bookingToken={bookingToken}
            sponsor={pickCheckoutSponsor(visibleSponsors)}
          />
        )}

        {effectivePhase === 'arrival' && (
          <ArrivalPhaseContent
            heroSponsor={heroSponsor}
            property={property}
            config={config}
            onTapOffer={openPass}
          />
        )}

        {effectivePhase === 'mid' && (
          <MidStayPhaseContent
            heroSponsor={heroSponsor}
            secondarySponsors={secondarySponsors}
            property={property}
            config={config}
            extensionRequest={extensionRequest}
            extensionConfig={extensionConfig}
            onTapOffer={openPass}
          />
        )}

        <p className={styles.foot}>{property.name} · Powered by FieldStay</p>
      </div>

      <RedemptionPassOverlay
        pass={pass}
        propertyName={property.name}
        bookingToken={bookingToken}
        onClose={() => setPass(null)}
      />
    </div>
  )
}

function SkyMoment({
  skyState, weather, momentLine,
}: Readonly<{
  skyState:   SkyState
  weather:    WeatherContext | null
  momentLine: string
}>) {
  const weatherLabel = weather
    ? weather.isSnowy ? 'Snowy' : weather.isRainy ? 'Rainy' : weather.isCold ? 'Cold' : weather.isHot ? 'Hot' : 'Mild weather'
    : ''

  return (
    <div className={styles.moment}>
      <div className={styles.momentRow}>
        <div className={styles.greet}>{GREETING[skyState]}</div>
        {weather && (
          <div className={styles.wx}>
            <span role="img" aria-label={weatherLabel}><WeatherIcon weather={weather} /></span>
            <span>{Math.round(weather.temperature)}°F</span>
          </div>
        )}
      </div>
      <p className={styles.momentLine}>{momentLine}</p>
    </div>
  )
}

function PropertyTicket({
  property, heroPhotoUrl, stay,
}: Readonly<{
  property:     Property
  heroPhotoUrl: string | null
  stay:         StayInfo | null
}>) {
  return (
    <div className={styles.ticket}>
      {/* eslint-disable-next-line @next/next/no-img-element -- guest-facing storage image, no next/image domain config on this public surface */}
      <div className={styles.heroImg}>{heroPhotoUrl && <img src={heroPhotoUrl} alt="" />}</div>
      <div className={styles.ticketBody}>
        <p className={styles.propEyebrow}>Your stay at</p>
        <h1 className={styles.propName}>{property.name}</h1>
        {stay && <StayStrip stay={stay} />}
      </div>
    </div>
  )
}

function StayStrip({ stay }: Readonly<{ stay: StayInfo }>) {
  const label = stay.phase === 'checkout' ? 'Last morning' : `Night ${stay.nightIndex + 1} of ${stay.totalNights}`
  const dots = Array.from({ length: stay.totalNights }, (_, i) => {
    if (i < stay.nightIndex) return 'done'
    if (i === stay.nightIndex) return 'now'
    return 'todo'
  })

  return (
    <div className={styles.stayStrip}>
      <span>{label}</span>
      <div className={styles.dots}>
        {dots.map((state, i) => (
          <span
            key={`dot-${i}`}
            className={
              state === 'done' ? `${styles.dot} ${styles.dotDone}`
                : state === 'now' ? `${styles.dot} ${styles.dotNow}`
                  : styles.dot
            }
          />
        ))}
      </div>
    </div>
  )
}

function QuickActionsRow({
  wifiOpen, onToggleWifi, directionsUrl, onScrollToCheckSection, checkoutPhase,
}: Readonly<{
  wifiOpen:                boolean
  onToggleWifi:            () => void
  directionsUrl:           string | null
  onScrollToCheckSection:  () => void
  checkoutPhase:           boolean
}>) {
  const chipCount = directionsUrl ? 3 : 2

  return (
    <div className={styles.quick} style={{ gridTemplateColumns: `repeat(${chipCount}, 1fr)` }}>
      <button
        type="button"
        className={wifiOpen ? `${styles.qa} ${styles.qaGold}` : styles.qa}
        onClick={onToggleWifi}
      >
        <Wifi />
        <div className={styles.qaLbl}>Wifi</div>
      </button>
      {directionsUrl && (
        <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className={styles.qa}>
          <MapPin />
          <div className={styles.qaLbl}>Directions</div>
        </a>
      )}
      <button type="button" className={styles.qa} onClick={onScrollToCheckSection}>
        <Key />
        <div className={styles.qaLbl}>{checkoutPhase ? 'Checkout' : 'Check-in'}</div>
      </button>
    </div>
  )
}

function SectionHead({ title, live }: Readonly<{ title: string; live?: string }>) {
  return (
    <div className={styles.secHead}>
      <span className={styles.secHeadT}>{title}</span>
      <span className={styles.secHeadLine} />
      {live && <span className={styles.secHeadLive}>{live}</span>}
    </div>
  )
}

function SponsorHeroCard({
  sponsor, why, property, onTapOffer,
}: Readonly<{
  sponsor:    GuidebookSponsorView
  why:        string
  property:   Property
  onTapOffer: (sponsor: GuidebookSponsorView, offerLine: string) => void
}>) {
  const offerLine = formatOffer(sponsor.offer_type, sponsor.offer_value, sponsor.offer_item, sponsor.custom_offer_text)
  const distance  = sponsorDistanceMinutes(property, sponsor)
  const dirUrl    = sponsorDirectionsUrl(sponsor)

  return (
    <div className={styles.recHero}>
      <div className={styles.recImg}>
        {sponsor.photoUrl
          // eslint-disable-next-line @next/next/no-img-element -- guest-facing storage image, no next/image domain config on this public surface
          ? <img src={sponsor.photoUrl} alt="" />
          : <span className={styles.recImgPh}>{SLOT_EMOJI[sponsor.slot_type]}</span>}
        <span className={styles.recWhy}>{why}</span>
      </div>
      <div className={styles.recBody}>
        <h3 className={styles.recName}>{sponsor.business_name}</h3>
        {sponsor.business_description && <p className={styles.recDesc}>{sponsor.business_description}</p>}
        {offerLine && (
          <button type="button" className={styles.offer} onClick={() => onTapOffer(sponsor, offerLine)}>
            <p className={styles.offerK}>Guidebook exclusive</p>
            <p className={styles.offerV}>{offerLine}</p>
            <span className={styles.offerTap}>Tap to redeem</span>
          </button>
        )}
        <div className={styles.recActions}>
          {dirUrl && (
            <a href={dirUrl} target="_blank" rel="noopener noreferrer" className={`${styles.btn} ${styles.btnPrimary}`}>
              Directions{distance !== null ? ` · ${distance} min` : ''}
            </a>
          )}
          {sponsor.business_phone && (
            <a href={`tel:${sponsor.business_phone}`} className={`${styles.btn} ${styles.btnGhost}`}>Call</a>
          )}
        </div>
      </div>
    </div>
  )
}

function SponsorRow({ sponsor }: Readonly<{ sponsor: GuidebookSponsorView }>) {
  const dirUrl = sponsorDirectionsUrl(sponsor)
  const desc   = sponsor.featured_item ?? (sponsor.business_description ? truncate(sponsor.business_description, 60) : '')

  return (
    <div className={styles.recRow}>
      <div className={styles.recThumb}>
        {sponsor.photoUrl
          // eslint-disable-next-line @next/next/no-img-element -- guest-facing storage image, no next/image domain config on this public surface
          ? <img src={sponsor.photoUrl} alt="" />
          : SLOT_EMOJI[sponsor.slot_type]}
      </div>
      <div className={styles.recRowInfo}>
        <p className={styles.recRowN}>{sponsor.business_name}</p>
        <p className={styles.recRowD}>{desc}</p>
      </div>
      {dirUrl && (
        <a href={dirUrl} target="_blank" rel="noopener noreferrer" className={styles.recRowGo}>
          Directions
        </a>
      )}
    </div>
  )
}

function CheckoutChecklist({
  instructions, bookingToken, slug,
}: Readonly<{
  instructions: string | null
  bookingToken: string | null
  slug:         string
}>) {
  const items = parseChecklistItems(instructions)
  const storageKey = `gb-checkout-${bookingToken ?? slug}`
  const [checked, setChecked] = useState<Set<number>>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey)
      return raw ? new Set(JSON.parse(raw) as number[]) : new Set<number>()
    } catch {
      // localStorage unavailable (private browsing, disabled) — checklist just won't persist
      return new Set<number>()
    }
  })

  function toggle(index: number) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify(Array.from(next)))
      } catch {
        // localStorage unavailable — nothing to persist to, checklist state stays in memory only
      }
      return next
    })
  }

  if (items.length < 2) {
    return (
      <div className={styles.infoCard}>
        <p>{instructions ?? 'Check-out details coming soon.'}</p>
      </div>
    )
  }

  return (
    <div className={styles.infoCard}>
      {items.map((item, i) => (
        <div
          key={`${i}-${item}`}
          role="button"
          tabIndex={0}
          className={styles.checkItem}
          onClick={() => toggle(i)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle(i)
            }
          }}
        >
          <span className={checked.has(i) ? `${styles.checkBox} ${styles.checkBoxChecked}` : styles.checkBox} />
          <span>{item}</span>
        </div>
      ))}
    </div>
  )
}

function CheckoutPhaseContent({
  config, checkOutTime, bookingToken, sponsor,
}: Readonly<{
  config:       GuidebookPropertyConfig
  checkOutTime: string | null
  bookingToken: string | null
  sponsor:      GuidebookSponsorView | null
}>) {
  return (
    <div id="gb-checkout-section">
      <div className={styles.sec}>
        <SectionHead title="Before you head out" live={checkOutTime ?? undefined} />
        <CheckoutChecklist
          instructions={config.check_out_instructions}
          bookingToken={bookingToken}
          slug={config.slug}
        />
      </div>
      {sponsor && (
        <div className={styles.sec}>
          <SectionHead title="One for the road" />
          <SponsorRow sponsor={sponsor} />
        </div>
      )}
    </div>
  )
}

function ArrivalPhaseContent({
  heroSponsor, property, config, onTapOffer,
}: Readonly<{
  heroSponsor: GuidebookSponsorView | null
  property:    Property
  config:      GuidebookPropertyConfig
  onTapOffer:  (sponsor: GuidebookSponsorView, offerLine: string) => void
}>) {
  return (
    <div id="gb-checkin-section">
      {heroSponsor && (
        <div className={styles.sec}>
          <SectionHead title="Right now nearby" live="Live" />
          <SponsorHeroCard sponsor={heroSponsor} why={WHY_CHIP[heroSponsor.slot_type]} property={property} onTapOffer={onTapOffer} />
        </div>
      )}

      <div className={styles.sec}>
        <SectionHead title="Getting in" />
        <div className={styles.infoCard}>
          <p>{config.check_in_instructions ?? 'Check-in details coming soon.'}</p>
        </div>
      </div>

      {config.house_rules && (
        <div className={styles.sec}>
          <SectionHead title="House rules" />
          <div className={styles.infoCard}>
            <p>{config.house_rules}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function MidStayPhaseContent({
  heroSponsor, secondarySponsors, property, config, extensionRequest, extensionConfig, onTapOffer,
}: Readonly<{
  heroSponsor:       GuidebookSponsorView | null
  secondarySponsors: GuidebookSponsorView[]
  property:          Property
  config:            GuidebookPropertyConfig
  extensionRequest:  ExtensionRequestProp | null
  extensionConfig:   ExtensionConfigProp | null
  onTapOffer:        (sponsor: GuidebookSponsorView, offerLine: string) => void
}>) {
  return (
    <div id="gb-checkin-section">
      {(heroSponsor || secondarySponsors.length > 0) && (
        <div className={styles.sec}>
          <SectionHead title="Right now nearby" live="Live" />
          {heroSponsor && (
            <SponsorHeroCard sponsor={heroSponsor} why={WHY_CHIP[heroSponsor.slot_type]} property={property} onTapOffer={onTapOffer} />
          )}
          {secondarySponsors.map((s) => (
            <SponsorRow key={s.id} sponsor={s} />
          ))}
        </div>
      )}

      {extensionRequest && extensionConfig && (
        <div className={styles.sec}>
          <ExtendStayCard extensionRequest={extensionRequest} extensionConfig={extensionConfig} />
        </div>
      )}

      {config.house_rules && (
        <div className={styles.sec}>
          <SectionHead title="House rules" />
          <div className={styles.infoCard}>
            <p>{config.house_rules}</p>
          </div>
        </div>
      )}

      <div id="gb-checkout-section" className={styles.sec}>
        <SectionHead title="Check-out" />
        <div className={styles.infoCard}>
          <p>{config.check_out_instructions ?? 'Check-out details coming soon.'}</p>
        </div>
      </div>
    </div>
  )
}

function ExtendStayCard({
  extensionRequest, extensionConfig,
}: Readonly<{
  extensionRequest: ExtensionRequestProp
  extensionConfig:  ExtensionConfigProp
}>) {
  return (
    <div className={styles.extend}>
      <p className={styles.extendK}>Extend your stay</p>
      <p className={styles.extendP}>
        {extensionRequest.gap_days} night{extensionRequest.gap_days !== 1 ? 's' : ''} available after your checkout
        {extensionRequest.discount_pct ? ` — ${extensionRequest.discount_pct}% off if you book now` : ''}.
      </p>
      {extensionConfig.extension_contact_method === 'ownerrez_url' && extensionConfig.extension_ownerrez_url ? (
        <a
          href={extensionConfig.extension_ownerrez_url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${styles.btn} ${styles.btnPrimary}`}
        >
          Check availability →
        </a>
      ) : (
        <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
          Reply to our text message or contact your host directly to extend.
        </p>
      )}
    </div>
  )
}

function RedemptionPassOverlay({
  pass, propertyName, bookingToken, onClose,
}: Readonly<{
  pass:         { sponsorId: string; businessName: string; offerLine: string } | null
  propertyName: string
  bookingToken: string | null
  onClose:      () => void
}>) {
  // Ticks once a second while open purely to force a re-render — the clock
  // text itself is always computed fresh from `new Date()` at render time
  // below, so there's no stale state to sync from inside the effect.
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (!pass) return undefined

    const intervalId = globalThis.setInterval(() => forceTick((t) => t + 1), 1000)

    fetch('/api/guidebook/redeem', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sponsorId: pass.sponsorId, bookingToken }),
    }).catch(() => {})

    return () => globalThis.clearInterval(intervalId)
  }, [pass, bookingToken])

  if (!pass) return null

  return (
    <div
      className={styles.passOverlay}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className={styles.passInner}>
        <div className={styles.pass}>
          <div className={styles.passTop}>
            <p className={styles.passEyebrow}>Guest Perk · Verified Live</p>
            <p className={styles.passBiz}>{pass.businessName}</p>
            <p className={styles.passOffer}>{pass.offerLine}</p>
          </div>
          <div className={styles.passSeam} />
          <div className={styles.passBottom}>
            <div>
              <p className={styles.passMetaK}>Staying at</p>
              <p className={styles.passMetaV}>{propertyName}</p>
            </div>
            <div className={styles.passClock}>{formatClock(new Date())}</div>
          </div>
        </div>
        <p className={styles.passHint}>Show this screen to staff — clock proves it&apos;s live</p>
        <button type="button" className={styles.passClose} onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
