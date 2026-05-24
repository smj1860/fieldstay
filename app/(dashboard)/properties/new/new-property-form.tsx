'use client'

import { useActionState } from 'react'
import { createProperty } from '../actions'
import Link from 'next/link'

const PROPERTY_TYPES = [
  { value: 'house',     label: 'House' },
  { value: 'cabin',     label: 'Cabin' },
  { value: 'condo',     label: 'Condo' },
  { value: 'cottage',   label: 'Cottage' },
  { value: 'townhouse', label: 'Townhouse' },
  { value: 'other',     label: 'Other' },
]

export function NewPropertyForm() {
  const [state, action, pending] = useActionState(createProperty, null)

  return (
    <form action={action} className="space-y-6">
      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {state.error}
        </div>
      )}

      {/* Name */}
      <div>
        <label htmlFor="name" className="label">
          Property Name <span className="text-red-500">*</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          className="input"
          placeholder="e.g. Blue Haven, The Dock House"
        />
      </div>

      {/* Type + Beds + Baths */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label htmlFor="property_type" className="label">Type</label>
          <select id="property_type" name="property_type" className="input">
            {PROPERTY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bedrooms" className="label">Bedrooms</label>
          <input
            id="bedrooms" name="bedrooms" type="number"
            min="0" max="20" defaultValue={3} className="input"
          />
        </div>
        <div>
          <label htmlFor="bathrooms" className="label">Bathrooms</label>
          <input
            id="bathrooms" name="bathrooms" type="number"
            min="0.5" max="20" step="0.5" defaultValue={2} className="input"
          />
        </div>
      </div>

      {/* Address */}
      <div>
        <label htmlFor="address" className="label">Street Address</label>
        <input
          id="address" name="address" type="text"
          className="input" placeholder="123 Lake Shore Drive"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1">
          <label htmlFor="city" className="label">City</label>
          <input id="city" name="city" type="text" className="input" placeholder="Dadeville" />
        </div>
        <div>
          <label htmlFor="state" className="label">State</label>
          <input id="state" name="state" type="text" className="input" placeholder="AL" maxLength={2} />
        </div>
        <div>
          <label htmlFor="zip" className="label">ZIP</label>
          <input id="zip" name="zip" type="text" className="input" placeholder="36853" maxLength={10} />
        </div>
      </div>

      {/* Check-in / Check-out times */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="checkin_time" className="label">Check-in Time</label>
          <input
            id="checkin_time" name="checkin_time" type="time"
            defaultValue="15:00" className="input"
          />
        </div>
        <div>
          <label htmlFor="checkout_time" className="label">Check-out Time</label>
          <input
            id="checkout_time" name="checkout_time" type="time"
            defaultValue="11:00" className="input"
          />
        </div>
      </div>

      {/* Access info */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="wifi_name" className="label">Wi-Fi Name</label>
          <input id="wifi_name" name="wifi_name" type="text" className="input" />
        </div>
        <div>
          <label htmlFor="wifi_password" className="label">Wi-Fi Password</label>
          <input id="wifi_password" name="wifi_password" type="text" className="input" />
        </div>
      </div>

      <div>
        <label htmlFor="door_code" className="label">Door Code / Lockbox</label>
        <input
          id="door_code" name="door_code" type="text"
          className="input" placeholder="e.g. 1234 or lockbox on front door"
        />
      </div>

      <div>
        <label htmlFor="internal_notes" className="label">Internal Notes</label>
        <textarea
          id="internal_notes" name="internal_notes" rows={3}
          className="input resize-none"
          placeholder="Anything the crew or vendors should know…"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2 border-t border-accent-100">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? 'Saving…' : 'Save & Continue →'}
        </button>
        <Link href="/properties" className="btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  )
}
