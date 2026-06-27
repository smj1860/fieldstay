'use client'

import { useState } from 'react'
import { upsertSponsor } from '@/app/actions/guidebook'
import type { GuidebookSponsor, GuidebookSlotType } from '@/types/database'

const SLOT_TYPE_OPTIONS: { value: GuidebookSlotType; label: string }[] = [
  { value: 'morning_brew',       label: 'Morning Brew (early hours)' },
  { value: 'dinner_pints',       label: 'Dinner & Pints (evening)' },
  { value: 'rainy_day',          label: 'Rainy Day (bad weather)' },
  { value: 'outdoor_adventure',  label: 'Outdoor Adventure (good weather)' },
  { value: 'general',           label: 'General (always shown)' },
  { value: 'other',              label: 'Other' },
]

interface SponsorFormModalProps {
  slotNumber: number
  existing:   GuidebookSponsor | null
  appUrl:     string
  onClose:    () => void
  onSaved:    () => void
}

export function SponsorFormModal({ slotNumber, existing, appUrl, onClose, onSaved }: SponsorFormModalProps) {
  const [businessName, setBusinessName]               = useState(existing?.business_name ?? '')
  const [businessDescription, setBusinessDescription] = useState(existing?.business_description ?? '')
  const [businessPhone, setBusinessPhone]              = useState(existing?.business_phone ?? '')
  const [businessWebsite, setBusinessWebsite]          = useState(existing?.business_website ?? '')
  const [customOfferText, setCustomOfferText]          = useState(existing?.custom_offer_text ?? '')
  const [featuredItem, setFeaturedItem]                = useState(existing?.featured_item ?? '')
  const [address, setAddress]                          = useState(existing?.address ?? '')
  const [slotType, setSlotType]                        = useState<GuidebookSlotType>(existing?.slot_type ?? 'general')
  const [slotContext, setSlotContext]                  = useState(existing?.slot_context ?? '')
  const [isSaving, setIsSaving]                        = useState(false)
  const [error, setError]                              = useState<string | null>(null)
  const [mediaKitToken, setMediaKitToken]               = useState<string | null>(existing?.media_kit_token ?? null)

  async function handleSubmit() {
    if (!businessName.trim()) {
      setError('Business name is required.')
      return
    }

    setIsSaving(true)
    setError(null)

    const result = await upsertSponsor({
      slotNumber,
      businessName:        businessName.trim(),
      businessDescription: businessDescription.trim() || null,
      businessPhone:        businessPhone.trim() || null,
      businessWebsite:      businessWebsite.trim() || null,
      customOfferText:      customOfferText.trim() || null,
      featuredItem:          featuredItem.trim() || null,
      address:               address.trim() || null,
      lat:                   existing?.lat ?? null,
      lng:                   existing?.lng ?? null,
      slotType,
      slotContext:           slotContext.trim() || null,
    })

    setIsSaving(false)

    if ('error' in result) {
      setError(result.error)
      return
    }

    setMediaKitToken(result.mediaKitToken)
    onSaved()
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '24px',
          maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontSize: '17px', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 16px' }}>
          {existing ? 'Edit' : 'Add'} Sponsor — Slot {slotNumber}
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Field label="Business Name">
            <input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Description">
            <textarea
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' as const }}
            />
          </Field>

          <Field label="Phone">
            <input
              value={businessPhone}
              onChange={(e) => setBusinessPhone(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Website">
            <input
              value={businessWebsite}
              onChange={(e) => setBusinessWebsite(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Address">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Custom Offer Text">
            <input
              value={customOfferText}
              onChange={(e) => setCustomOfferText(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Featured Item">
            <input
              value={featuredItem}
              onChange={(e) => setFeaturedItem(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Slot Type">
            <select
              value={slotType}
              onChange={(e) => setSlotType(e.target.value as GuidebookSlotType)}
              style={inputStyle}
            >
              {SLOT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Slot Context (optional notes)">
            <input
              value={slotContext}
              onChange={(e) => setSlotContext(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        {error && (
          <p style={{ color: 'var(--accent-red)', fontSize: '13px', marginTop: '12px' }}>{error}</p>
        )}

        {mediaKitToken && (
          <p style={{ color: 'var(--accent-green)', fontSize: '13px', marginTop: '12px' }}>
            Media kit link: {appUrl}/g/kit/{mediaKitToken}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '13px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius)',
              border: 'none', background: 'var(--accent-gold)',
              color: 'var(--text-inverse)', cursor: isSaving ? 'default' : 'pointer',
              fontSize: '13px', fontWeight: '600', opacity: isSaving ? 0.6 : 1,
            }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width:        '100%',
  padding:      '8px 10px',
  borderRadius: 'var(--radius)',
  border:       '1px solid var(--border)',
  background:   'var(--bg-raised)',
  color:        'var(--text-primary)',
  fontSize:     '13px',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  )
}
