'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react'
import { Sun, Wine, CloudRain, Tent, MapPin, Pencil, Check, type LucideIcon } from 'lucide-react'
import { SponsorFormModal } from './sponsor-form-modal'
import { CelebrationModal } from './celebration-modal'
import { upsertPropertyGuidebookConfig, updateStayExtensionSettings } from '@/app/actions/guidebook'
import type { GuidebookSponsor, GuidebookConfiguration, GuidebookSlotType, GuidebookSponsorStatus } from '@/types/database'

type Property = { id: string; name: string; address: string | null; lat: number | null; lng: number | null }

const SLOT_TYPE_CONFIG: Record<GuidebookSlotType, { icon: LucideIcon; label: string }> = {
  morning_brew:      { icon: Sun,       label: 'Morning Brew' },
  dinner_pints:      { icon: Wine,      label: 'Dinner & Pints' },
  rainy_day:         { icon: CloudRain, label: 'Rainy Day' },
  outdoor_adventure: { icon: Tent,      label: 'Outdoor Adventure' },
  general:           { icon: MapPin,    label: 'General' },
  other:             { icon: Pencil,    label: 'Custom' },
}

const STATUS_CONFIG: Record<GuidebookSponsorStatus, { label: string; color: string }> = {
  pending:        { label: 'Pending Payment', color: 'var(--accent-amber)' },
  active:         { label: 'Active',          color: 'var(--accent-green)' },
  payment_failed: { label: 'Payment Failed',  color: 'var(--accent-red)' },
  cancelled:      { label: 'Cancelled',       color: 'var(--text-muted)' },
}

interface GuidebookClientProps {
  orgId:                     string
  initialSponsors:           GuidebookSponsor[]
  initialConfig:             GuidebookConfiguration | null
  initialActiveSponsorCount: number
  properties:                Property[]
  appUrl:                    string
}

type CelebrationTier = 3 | 5 | 6 | null

// Plain helper, not a component — keeps the Date.now() call out of the
// component's own body (react-hooks/purity flags impure calls anywhere
// lexically inside a component, including inside useMemo callbacks).
function trialStatus(trialEndsAt: string | null): { inTrial: boolean; daysLeft: number } {
  if (!trialEndsAt) return { inTrial: false, daysLeft: 0 }
  const now      = Date.now()
  const endsAtMs = new Date(trialEndsAt).getTime()
  const inTrial  = now < endsAtMs
  return { inTrial, daysLeft: inTrial ? Math.ceil((endsAtMs - now) / 86400000) : 0 }
}

export function GuidebookClient({
  orgId,
  initialSponsors,
  initialConfig,
  initialActiveSponsorCount,
  properties,
  appUrl,
}: GuidebookClientProps) {
  const [sponsors, setSponsors]       = useState<GuidebookSponsor[]>(initialSponsors)
  const [config, setConfig]           = useState<GuidebookConfiguration | null>(initialConfig)
  const [editingSlot, setEditingSlot] = useState<number | null>(null)
  const [celebration, setCelebration] = useState<CelebrationTier>(null)
  const prevCountRef                  = useRef(initialActiveSponsorCount)
  const supabase                      = createClient()

  const activeSponsorCount = sponsors.filter((s) => s.status === 'active').length
  const isGuidebookActive  = config?.is_active ?? false

  const trialEndsAt              = config?.trial_ends_at ?? null
  const { inTrial, daysLeft: trialDaysLeft } = trialStatus(trialEndsAt)
  const hasAccess      = inTrial || activeSponsorCount >= 3
  const sponsorsNeeded = Math.max(0, 3 - activeSponsorCount)

  const checkCelebration = useCallback(
    (newCount: number, prevCount: number) => {
      const storageKey = 'guidebook_celebration_shown'
      const shown      = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as number[]

      for (const tier of [3, 5, 6] as const) {
        if (newCount >= tier && prevCount < tier && !shown.includes(tier)) {
          setCelebration(tier)
          localStorage.setItem(storageKey, JSON.stringify([...shown, tier]))
          break
        }
      }
    },
    []
  )

  useEffect(() => {
    const channel = supabase
      .channel(`guidebook-sponsors-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'guidebook_sponsors', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresChangesPayload<GuidebookSponsor>) => {
          setSponsors((prev) => {
            let next: GuidebookSponsor[]
            if (payload.eventType === 'INSERT') {
              next = [...prev, payload.new as GuidebookSponsor]
            } else if (payload.eventType === 'UPDATE') {
              next = prev.map((s) =>
                s.id === (payload.new as GuidebookSponsor).id ? (payload.new as GuidebookSponsor) : s
              )
            } else if (payload.eventType === 'DELETE') {
              next = prev.filter((s) => s.id !== (payload.old as GuidebookSponsor).id)
            } else {
              next = prev
            }
            const newActive  = next.filter((s) => s.status === 'active').length
            const prevActive = prevCountRef.current
            prevCountRef.current = newActive
            checkCelebration(newActive, prevActive)
            return next
          })
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'guidebook_configurations', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresChangesPayload<GuidebookConfiguration>) => { setConfig(payload.new as GuidebookConfiguration) }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [orgId, supabase, checkCelebration])

  const sponsorsBySlot = sponsors.reduce<Record<number, GuidebookSponsor>>((acc, s) => {
    acc[s.slot_number] = s
    return acc
  }, {})

  const editingSponsor = editingSlot !== null ? (sponsorsBySlot[editingSlot] ?? null) : null

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '32px 24px' }}>

      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>
          Guidebook
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', margin: 0 }}>
          Your guest-facing recommendation engine. Fill 3 sponsor slots to unlock it — free forever.
        </p>
      </div>

      {/* ── Trial countdown banner ──────────────────────────────────────────── */}
      {inTrial && (
        <div
          style={{
            borderRadius: 'var(--radius-lg)',
            padding:      '12px 16px',
            marginBottom: '16px',
            display:      'flex',
            alignItems:   'center',
            justifyContent: 'space-between',
            background:   trialDaysLeft <= 7 ? 'rgba(245,158,11,0.12)' : 'rgba(47,217,140,0.10)',
            border:       `1px solid ${trialDaysLeft <= 7 ? 'var(--accent-amber)' : 'var(--accent-green)'}`,
          }}
        >
          <div>
            <p style={{ fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)', margin: '0 0 2px' }}>
              {trialDaysLeft > 0
                ? `${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''} left in your free trial`
                : 'Your trial ends today'}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Add 3 sponsors to unlock the Guidebook permanently and earn plan credits.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '5px', marginLeft: '16px', flexShrink: 0 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: '12px', height: '12px', borderRadius: '50%',
                  backgroundColor: i < activeSponsorCount ? 'var(--accent-gold)' : 'var(--border-strong)',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Post-trial locked state banner ─────────────────────────────────── */}
      {!inTrial && !hasAccess && (
        <div
          style={{
            borderRadius: 'var(--radius-lg)',
            padding:      '20px',
            marginBottom: '16px',
            textAlign:    'center',
            background:   'var(--bg-card)',
            border:       '1px solid var(--border)',
          }}
        >
          <p style={{ fontWeight: '700', fontSize: '15px', color: 'var(--text-primary)', margin: '0 0 4px' }}>
            Add {sponsorsNeeded} more sponsor{sponsorsNeeded !== 1 ? 's' : ''} to unlock the Guidebook
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 16px' }}>
            Your 30-day trial has ended. 3 active sponsors unlock the Guidebook
            permanently — keep adding to earn plan credits.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '16px' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: '16px', height: '16px', borderRadius: '50%',
                  backgroundColor: i < activeSponsorCount ? 'var(--accent-gold)' : 'var(--border-strong)',
                }}
              />
            ))}
          </div>
          <button
            onClick={() => {
              document.querySelector<HTMLElement>('[data-sponsor-slots]')?.scrollIntoView({ behavior: 'smooth' })
            }}
            style={{
              fontSize: '13px', fontWeight: '600',
              padding: '8px 16px', borderRadius: 'var(--radius)',
              backgroundColor: 'var(--accent-gold)', color: 'var(--text-inverse)',
              border: 'none', cursor: 'pointer',
            }}
          >
            Add a Sponsor →
          </button>
        </div>
      )}

      <div
        style={{
          backgroundColor: isGuidebookActive ? 'var(--accent-green-dim)' : 'var(--accent-amber-dim)',
          border:          `1px solid ${isGuidebookActive ? 'var(--accent-green)' : 'var(--accent-amber)'}`,
          borderRadius:    'var(--radius-lg)',
          padding:         '16px 20px',
          marginBottom:    '28px',
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          flexWrap:        'wrap',
          gap:             '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '10px', height: '10px', borderRadius: '50%',
              backgroundColor: isGuidebookActive ? 'var(--accent-green)' : 'var(--accent-amber)',
              flexShrink: 0,
            }}
          />
          <div>
            <div style={{ fontWeight: '600', color: 'var(--text-primary)', fontSize: '14px' }}>
              {isGuidebookActive
                ? `Guidebook is live · ${activeSponsorCount} active sponsor${activeSponsorCount !== 1 ? 's' : ''}`
                : `${activeSponsorCount} of 3 sponsors · Guidebook locked`}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '2px' }}>
              {isGuidebookActive
                ? activeSponsorCount >= 6
                  ? '$25/month credit applied to your plan'
                  : activeSponsorCount >= 5
                  ? '$10/month credit applied to your plan'
                  : 'Add sponsors to earn a plan credit (5 = $10/mo, 6 = $25/mo)'
                : config?.grace_period_ends_at
                ? `Grace period — fill the slot before ${new Date(config.grace_period_ends_at).toLocaleDateString()} to avoid losing your guidebook`
                : `Add ${sponsorsNeeded} more sponsor${sponsorsNeeded !== 1 ? 's' : ''} to unlock`}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div
              key={n}
              style={{
                width: '28px', height: '6px', borderRadius: '3px',
                backgroundColor: n <= activeSponsorCount ? 'var(--accent-green)' : 'var(--border-strong)',
                transition: 'background-color 0.3s ease',
              }}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          backgroundColor: 'var(--bg-card)',
          border:          '1px solid var(--border)',
          borderRadius:    'var(--radius-lg)',
          overflow:        'hidden',
          marginBottom:    '32px',
        }}
      >
        <div data-sponsor-slots style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
              Sponsor Slots
            </h2>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {activeSponsorCount}/6 active
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
            Each slot gets its own Media Kit link — share it with a local business during
            your sponsor conversation. It previews their listing exactly as guests will see
            it and lets them subscribe on the spot, no paperwork required.
          </p>
        </div>

        {[1, 2, 3, 4, 5, 6].map((slotNum) => {
          const sponsor   = sponsorsBySlot[slotNum]
          const statusCfg = sponsor ? STATUS_CONFIG[sponsor.status] : null

          return (
            <div
              key={slotNum}
              style={{
                display: 'flex', alignItems: 'center', padding: '16px 20px',
                borderBottom: slotNum < 6 ? '1px solid var(--border)' : 'none',
                gap: '16px',
              }}
            >
              <div
                style={{
                  width: '32px', height: '32px', borderRadius: '50%',
                  backgroundColor: sponsor?.status === 'active' ? 'var(--bg-raised)' : 'var(--bg-hover)',
                  color:           sponsor?.status === 'active' ? 'var(--accent-gold)' : 'var(--text-muted)',
                  fontSize: '13px', fontWeight: '700',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                {slotNum}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                {sponsor ? (
                  <>
                    <div style={{ fontWeight: '600', color: 'var(--text-primary)', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sponsor.business_name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        {(() => {
                          const SlotIcon = SLOT_TYPE_CONFIG[sponsor.slot_type].icon
                          return <SlotIcon className="w-3.5 h-3.5" />
                        })()}
                        {SLOT_TYPE_CONFIG[sponsor.slot_type].label}
                      </span>
                      {statusCfg && (
                        <span
                          style={{
                            fontSize: '11px', fontWeight: '600', color: statusCfg.color,
                            backgroundColor: `${statusCfg.color}`.startsWith('var')
                              ? 'rgba(255,255,255,0.08)'
                              : statusCfg.color,
                            padding: '2px 7px', borderRadius: '999px',
                          }}
                        >
                          {statusCfg.label}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    Empty slot — add a local business
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                {sponsor && (
                  <>
                    <a
                      href={`${appUrl}/g/kit/${sponsor.media_kit_token}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                        padding: '6px 12px', textDecoration: 'none', backgroundColor: 'var(--bg-card)',
                      }}
                    >
                      Media Kit
                    </a>
                    <SponsorOnePagerButton sponsor={sponsor} appUrl={appUrl} />
                  </>
                )}
                <button
                  onClick={() => setEditingSlot(slotNum)}
                  style={{
                    fontSize: '13px', fontWeight: '500', color: 'var(--text-inverse)',
                    backgroundColor: 'var(--accent-gold)', border: 'none',
                    borderRadius: 'var(--radius)', padding: '6px 14px', cursor: 'pointer',
                  }}
                >
                  {sponsor ? 'Edit' : 'Add Sponsor'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <GapNightMessagingSection config={config} />

      {properties.length > 0 && (
        <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h2 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>
              Property Guidebooks
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              Configure each property&apos;s guest URL, wifi, and check-in details.
            </p>
          </div>
          {properties.map((property) => (
            <PropertyGuidebookRow
              key={property.id}
              property={property}
              appUrl={appUrl}
              isGuidebookActive={isGuidebookActive}
            />
          ))}
        </div>
      )}

      {editingSlot !== null && (
        <SponsorFormModal
          slotNumber={editingSlot}
          existing={editingSponsor}
          appUrl={appUrl}
          onClose={() => setEditingSlot(null)}
          onSaved={() => setEditingSlot(null)}
        />
      )}

      {celebration !== null && (
        <CelebrationModal tier={celebration} onClose={() => setCelebration(null)} />
      )}
    </div>
  )
}

function PropertyGuidebookRow({
  property,
  appUrl,
  isGuidebookActive,
}: {
  property: Property
  appUrl: string
  isGuidebookActive: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        type="button"
        style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', cursor: 'pointer', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', textAlign: 'left' }}
        onClick={() => setExpanded((e) => !e)}
      >
        <div>
          <div style={{ fontWeight: '500', fontSize: '14px', color: 'var(--text-primary)' }}>
            {property.name}
          </div>
          {property.address && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {property.address}
            </div>
          )}
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {expanded ? '▲ Close' : '▼ Configure'}
        </span>
      </button>

      {expanded && (
        <PropertyGuidebookForm property={property} appUrl={appUrl} isGuidebookActive={isGuidebookActive} />
      )}
    </div>
  )
}

function PropertyGuidebookForm({
  property,
  appUrl,
  isGuidebookActive,
}: {
  property: Property
  appUrl:   string
  isGuidebookActive: boolean
}) {
  const supabase = createClient()
  const [config, setConfig] = useState<{
    slug: string
    checkInInstructions: string
    checkOutInstructions: string
    wifiNetwork: string
    wifiPassword: string
    houseRules: string
    isPublished: boolean
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState<string | null>(null)
  // Separate from `error` above (which is for save failures) — this is
  // specifically for the initial load, so a save error never gets
  // clobbered by a load-retry and vice versa.
  const [loadError, setLoadError] = useState<string | null>(null)
  // Bumping this re-runs the load effect — the only way to retry after a
  // failure, since there's otherwise no path back from an errored load.
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoadError(null)
      const { data, error } = await supabase
        .from('guidebook_property_configs')
        .select('*')
        .eq('property_id', property.id)
        .maybeSingle()

      if (cancelled) return

      if (error) {
        console.error('[guidebook] Failed to load config:', error)
        // Do NOT fall through to the blank default on error — that would risk
        // overwriting an existing config on the next save. Surface it
        // instead of leaving config permanently null with no explanation.
        setLoadError('Failed to load this property’s guidebook settings.')
        return
      }

      if (data) {
        setConfig({
          slug:                 data.slug,
          checkInInstructions:  data.check_in_instructions ?? '',
          checkOutInstructions: data.check_out_instructions ?? '',
          wifiNetwork:          data.wifi_network ?? '',
          wifiPassword:         data.wifi_password ?? '',
          houseRules:           data.house_rules ?? '',
          isPublished:          data.is_published,
        })
      } else {
        const slug = property.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        setConfig({
          slug,
          checkInInstructions: '', checkOutInstructions: '',
          wifiNetwork: '', wifiPassword: '', houseRules: '',
          isPublished: false,
        })
      }
    }

    load()
    return () => { cancelled = true }
  }, [property.id, property.name, supabase, loadAttempt])

  if (loadError) {
    return (
      <div style={{ padding: '20px', fontSize: '14px' }}>
        <div style={{ color: 'var(--accent-red)', marginBottom: '8px' }}>{loadError}</div>
        <button
          type="button"
          onClick={() => setLoadAttempt((n) => n + 1)}
          style={{
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '6px 14px', fontSize: '13px',
            color: 'var(--text-primary)', cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!config) {
    return <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '14px' }}>Loading…</div>
  }

  const guestUrl = `${appUrl}/g/${config.slug}`

  async function handleSave() {
    if (!config) return
    setSaving(true)
    setError(null)
    const result = await upsertPropertyGuidebookConfig({
      propertyId:           property.id,
      slug:                 config.slug,
      checkInInstructions:  config.checkInInstructions || null,
      checkOutInstructions: config.checkOutInstructions || null,
      wifiNetwork:          config.wifiNetwork || null,
      wifiPassword:         config.wifiPassword || null,
      houseRules:           config.houseRules || null,
      isPublished:          config.isPublished,
    })
    setSaving(false)
    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    padding: '8px 12px', fontSize: '14px', color: 'var(--text-primary)',
    background: 'var(--bg-raised)', outline: 'none', boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px',
  }

  return (
    <div style={{ padding: '0 20px 20px', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>

        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>Guest URL Slug</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {appUrl}/g/
            </span>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={config.slug}
              onChange={(e) => setConfig((c) => c && ({ ...c, slug: e.target.value }))}
              placeholder="bear-hollow-cabin"
            />
          </div>
          {config.isPublished && (
            <>
              <a href={guestUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: 'var(--accent-blue)', marginTop: '4px', display: 'block' }}>
                {guestUrl} ↗
              </a>
              <GuidebookQrCode url={guestUrl} propertyName={property.name} />
            </>
          )}
        </div>

        <div>
          <label style={labelStyle}>WiFi Network</label>
          <input style={inputStyle} value={config.wifiNetwork} onChange={(e) => setConfig((c) => c && ({ ...c, wifiNetwork: e.target.value }))} placeholder="CabinWifi_5G" />
        </div>
        <div>
          <label style={labelStyle}>WiFi Password</label>
          <input style={inputStyle} value={config.wifiPassword} onChange={(e) => setConfig((c) => c && ({ ...c, wifiPassword: e.target.value }))} placeholder="bearhollowguest2024" />
        </div>

        <div>
          <label style={labelStyle}>Check-In Instructions</label>
          <textarea
            style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' }}
            value={config.checkInInstructions}
            onChange={(e) => setConfig((c) => c && ({ ...c, checkInInstructions: e.target.value }))}
            placeholder="Door code is 4821. Parking is in the gravel lot to the left."
          />
        </div>
        <div>
          <label style={labelStyle}>Check-Out Instructions</label>
          <textarea
            style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' }}
            value={config.checkOutInstructions}
            onChange={(e) => setConfig((c) => c && ({ ...c, checkOutInstructions: e.target.value }))}
            placeholder="Leave key on the counter. Check-out by 11 AM."
          />
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>House Rules (optional)</label>
          <textarea
            style={{ ...inputStyle, minHeight: '60px', resize: 'vertical', fontFamily: 'inherit' }}
            value={config.houseRules}
            onChange={(e) => setConfig((c) => c && ({ ...c, houseRules: e.target.value }))}
            placeholder="No smoking indoors. Pets welcome on the deck."
          />
        </div>

        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.isPublished}
              onChange={(e) => setConfig((c) => c && ({ ...c, isPublished: e.target.checked }))}
              disabled={!isGuidebookActive}
            />
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Publish (guests can access the guidebook URL)
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {error && <span style={{ fontSize: '13px', color: 'var(--accent-red)' }}>{error}</span>}
            {saved && <span style={{ fontSize: '13px', color: 'var(--accent-green)' }}>Saved</span>}
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                backgroundColor: 'var(--accent-gold)', color: 'var(--text-inverse)', border: 'none',
                borderRadius: 'var(--radius)', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function GapNightMessagingSection({ config }: { config: GuidebookConfiguration | null }) {
  const [enabled, setEnabled]           = useState(config?.extension_messaging_enabled ?? false)
  const [gapThreshold, setGapThreshold] = useState(String(config?.extension_gap_threshold_days ?? 7))
  const [discount, setDiscount]         = useState(
    config?.extension_discount_pct != null ? String(config.extension_discount_pct) : ''
  )
  const [contactMethod, setContactMethod] = useState<'ownerrez_url' | 'email' | 'sms'>(
    config?.extension_contact_method && config.extension_contact_method !== null
      ? config.extension_contact_method
      : 'email'
  )
  const [ownerRezUrl, setOwnerRezUrl] = useState(config?.extension_ownerrez_url ?? '')
  const [daysBefore, setDaysBefore]   = useState(String(config?.extension_message_days_before ?? 2))

  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const labelStyle: React.CSSProperties = {
    fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: '6px',
  }
  const inputStyle: React.CSSProperties = {
    width: '100%', maxWidth: '120px', padding: '8px 10px', fontSize: '14px',
    color: 'var(--text-primary)', backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)

    const result = await updateStayExtensionSettings({
      enabled,
      gapThresholdDays: Number(gapThreshold) || 7,
      discountPct:      discount.trim() === '' ? null : Number(discount),
      contactMethod,
      ownerRezUrl:      contactMethod === 'ownerrez_url' ? (ownerRezUrl.trim() || null) : null,
      daysBefore:       Number(daysBefore) || 2,
    })

    setSaving(false)
    if (result.error) { setError(result.error); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div style={{
      backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '32px',
    }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>
          Gap Night Messaging
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
          Offer guests a chance to stay longer when there&apos;s a gap before the next booking.
        </p>
      </div>

      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Enable toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
            Notify guests about staying longer when there&apos;s a gap
          </span>
        </label>

        {/* Gap threshold */}
        <div>
          <label style={labelStyle}>Only offer when the gap is at least</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="number" min={1} value={gapThreshold}
              onChange={(e) => setGapThreshold(e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>days</span>
          </div>
        </div>

        {/* Discount offer */}
        <div>
          <label style={labelStyle}>Include a discount offer (optional)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="number" min={0} max={100} value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="—"
              style={inputStyle}
            />
            <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>% off — leave blank for no discount</span>
          </div>
        </div>

        {/* Contact method */}
        <div>
          <label style={labelStyle}>When a guest is interested</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {([
              { value: 'ownerrez_url', label: 'Link guests to your OwnerRez booking page' },
              { value: 'email',        label: 'Send me an email' },
              { value: 'sms',          label: 'Send me a text' },
            ] as const).map((opt) => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="extension-contact-method"
                  checked={contactMethod === opt.value}
                  onChange={() => setContactMethod(opt.value)}
                  style={{ width: 14, height: 14 }}
                />
                <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>{opt.label}</span>
              </label>
            ))}
          </div>
          {contactMethod === 'ownerrez_url' && (
            <input
              type="url"
              value={ownerRezUrl}
              onChange={(e) => setOwnerRezUrl(e.target.value)}
              placeholder="https://app.ownerrez.com/..."
              style={{ ...inputStyle, maxWidth: '100%', marginTop: '8px' }}
            />
          )}
        </div>

        {/* Message timing */}
        <div>
          <label style={labelStyle}>Send the offer</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="number" min={1} value={daysBefore}
              onChange={(e) => setDaysBefore(e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>days before checkout</span>
          </div>
        </div>

        {error && (
          <p style={{ fontSize: '13px', color: 'var(--accent-red)', margin: 0 }}>{error}</p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              fontSize: '13px', fontWeight: 600, color: 'var(--text-inverse)',
              backgroundColor: 'var(--accent-gold)', border: 'none',
              borderRadius: 'var(--radius)', padding: '8px 18px',
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && (
            <span style={{ fontSize: '13px', color: 'var(--accent-green)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              Saved <Check className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// Renders a hidden QR canvas for the sponsor's media kit URL and, on click,
// builds a printable one-pager PDF (pitch copy + the sponsor's own preview
// info + the QR code) for the PM to hand a prospective business during an
// in-person sponsor conversation. PDF assembly lives in
// lib/guidebook/sponsor-one-pager.ts — this component only owns the DOM/canvas
// plumbing pdf-lib can't do itself (reading the rendered QR as PNG bytes).
function SponsorOnePagerButton({
  sponsor,
  appUrl,
}: Readonly<{
  sponsor: GuidebookSponsor
  appUrl:  string
}>) {
  const canvasRef                     = useRef<HTMLCanvasElement>(null)
  const [generating, setGenerating]   = useState(false)
  const kitUrl = `${appUrl}/g/kit/${sponsor.media_kit_token}`

  async function handleDownload() {
    const canvas = canvasRef.current
    if (!canvas) return

    setGenerating(true)
    try {
      const { buildSponsorOnePagerPdf } = await import('@/lib/guidebook/sponsor-one-pager')
      const qrPngBytes = await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer()
      const pdfBytes   = await buildSponsorOnePagerPdf(sponsor, qrPngBytes, kitUrl)

      const blob    = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' })
      const blobUrl = URL.createObjectURL(blob)
      const fileSlug = sponsor.business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

      const a = document.createElement('a')
      a.href     = blobUrl
      a.download = `${fileSlug}-sponsor-one-pager.pdf`
      a.click()
      URL.revokeObjectURL(blobUrl)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      <QRCodeCanvas ref={canvasRef} value={kitUrl} size={240} style={{ display: 'none' }} />
      <button
        onClick={handleDownload}
        disabled={generating}
        style={{
          fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          padding: '6px 12px', backgroundColor: 'var(--bg-card)',
          cursor: generating ? 'default' : 'pointer', opacity: generating ? 0.6 : 1,
        }}
      >
        {generating ? 'Generating…' : 'One-Pager'}
      </button>
    </>
  )
}

function GuidebookQrCode({ url, propertyName }: { url: string; propertyName: string }) {
  const qrId = `guidebook-qr-${propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

  function handleDownload() {
    const svg = document.getElementById(qrId)
    if (!svg) return

    const svgString = new XMLSerializer().serializeToString(svg)
    const blob       = new Blob([svgString], { type: 'image/svg+xml' })
    const blobUrl    = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href     = blobUrl
    a.download = `${qrId}.svg`
    a.click()
    URL.revokeObjectURL(blobUrl)
  }

  return (
    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <QRCodeSVG id={qrId} value={url} size={64} />
      <button
        onClick={handleDownload}
        style={{
          fontSize: '12px', fontWeight: '500', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          padding: '5px 10px', cursor: 'pointer', backgroundColor: 'var(--bg-card)',
        }}
      >
        Download QR Code
      </button>
    </div>
  )
}
