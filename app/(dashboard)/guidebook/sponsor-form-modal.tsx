'use client'

import { useState } from 'react'
import { upsertSponsor } from '@/app/actions/guidebook'
import { Dialog } from '@/components/ui/Dialog'
import type { GuidebookSponsor, GuidebookSlotType, GuidebookOfferType } from '@/types/database'

const OFFER_TYPE_OPTIONS: { value: GuidebookOfferType; label: string }[] = [
  { value: 'none',         label: 'No offer' },
  { value: 'percentage',   label: 'Percentage off' },
  { value: 'fixed_amount', label: 'Fixed amount off' },
  { value: 'item',         label: 'Free item' },
  { value: 'custom',       label: 'Custom text' },
]

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

export function SponsorFormModal({ slotNumber, existing, appUrl, onClose, onSaved }: Readonly<SponsorFormModalProps>) {
  const [businessName, setBusinessName]               = useState(existing?.business_name ?? '')
  const [businessDescription, setBusinessDescription] = useState(existing?.business_description ?? '')
  const [businessPhone, setBusinessPhone]              = useState(existing?.business_phone ?? '')
  const [businessWebsite, setBusinessWebsite]          = useState(existing?.business_website ?? '')
  const [customOfferText, setCustomOfferText]          = useState(existing?.custom_offer_text ?? '')
  const [offerType, setOfferType]                       = useState<GuidebookOfferType>(existing?.offer_type ?? 'none')
  const [offerValue, setOfferValue]                      = useState(existing?.offer_value?.toString() ?? '')
  const [offerItem, setOfferItem]                        = useState(existing?.offer_item ?? '')
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
      customOfferText:      offerType === 'custom' ? (customOfferText.trim() || null) : null,
      offerType,
      offerValue:           offerType === 'percentage' || offerType === 'fixed_amount' ? (Number(offerValue) || null) : null,
      offerItem:            offerType === 'item' ? (offerItem.trim() || null) : null,
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
    <Dialog
      open
      onClose={onClose}
      title={`${existing ? 'Edit' : 'Add'} Sponsor — Slot ${slotNumber}`}
      maxWidthClassName="max-w-md"
    >
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

          <Field label="Offer Type">
            <select
              value={offerType}
              onChange={(e) => setOfferType(e.target.value as GuidebookOfferType)}
              style={inputStyle}
            >
              {OFFER_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>

          {(offerType === 'percentage' || offerType === 'fixed_amount') && (
            <Field label={offerType === 'percentage' ? 'Percent Off' : 'Amount Off ($)'}>
              <input
                type="number"
                value={offerValue}
                onChange={(e) => setOfferValue(e.target.value)}
                style={inputStyle}
              />
            </Field>
          )}

          {offerType === 'item' && (
            <Field label="Free Item">
              <input
                value={offerItem}
                onChange={(e) => setOfferItem(e.target.value)}
                placeholder="e.g. coffee"
                style={inputStyle}
              />
            </Field>
          )}

          {offerType === 'custom' && (
            <Field label="Custom Offer Text">
              <input
                value={customOfferText}
                onChange={(e) => setCustomOfferText(e.target.value)}
                style={inputStyle}
              />
            </Field>
          )}

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
    </Dialog>
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
