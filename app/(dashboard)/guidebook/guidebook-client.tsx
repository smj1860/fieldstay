'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { QRCodeSVG } from 'qrcode.react'
import { SponsorFormModal } from './sponsor-form-modal'
import { CelebrationModal } from './celebration-modal'
import { upsertPropertyGuidebookConfig } from '@/app/actions/guidebook'
import type { GuidebookSponsor, GuidebookConfiguration, GuidebookSlotType, GuidebookSponsorStatus } from '@/types/database'

type Property = { id: string; name: string; address: string | null; lat: number | null; lng: number | null }

const SLOT_TYPE_LABELS: Record<GuidebookSlotType, string> = {
  morning_brew:      '☀️ Morning Brew',
  dinner_pints:      '🍷 Dinner & Pints',
  rainy_day:         '🌧️ Rainy Day',
  outdoor_adventure: '🏕️ Outdoor Adventure',
  general:           '📍 General',
  other:             '✏️ Custom',
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

type CelebrationTier = 4 | 5 | 6 | null

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

  const checkCelebration = useCallback(
    (newCount: number, prevCount: number) => {
      const storageKey = 'guidebook_celebration_shown'
      const shown      = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as number[]

      for (const tier of [4, 5, 6] as const) {
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
          Your guest-facing recommendation engine. Fill 4 sponsor slots to unlock it — free forever.
        </p>
      </div>

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
                : `${activeSponsorCount} of 4 sponsors · Guidebook locked`}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '2px' }}>
              {isGuidebookActive
                ? activeSponsorCount >= 6
                  ? '$25/month credit applied to your plan'
                  : activeSponsorCount >= 5
                  ? '$10/month credit applied to your plan'
                  : 'Add 2 more sponsors to earn a plan credit'
                : config?.grace_period_ends_at
                ? `Grace period — fill the slot before ${new Date(config.grace_period_ends_at).toLocaleDateString()} to avoid losing your guidebook`
                : `Add ${4 - activeSponsorCount} more sponsor${4 - activeSponsorCount !== 1 ? 's' : ''} to unlock`}
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
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
            Sponsor Slots
          </h2>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {activeSponsorCount}/6 active
          </span>
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
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {SLOT_TYPE_LABELS[sponsor.slot_type]}
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
      <div
        style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', cursor: 'pointer', justifyContent: 'space-between' }}
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
      </div>

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

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('guidebook_property_configs')
        .select('*')
        .eq('property_id', property.id)
        .maybeSingle()

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
  }, [property.id, property.name, supabase])

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
