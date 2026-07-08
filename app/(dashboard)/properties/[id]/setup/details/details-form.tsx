'use client'

import { useActionState } from 'react'
import { saveDetails } from './actions'
import Link from 'next/link'
import { Button, buttonVariantClass } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { Property } from '@/types/database'

const PROPERTY_TYPES = [
  { value: 'house', label: 'House' }, { value: 'cabin', label: 'Cabin' },
  { value: 'condo', label: 'Condo' }, { value: 'cottage', label: 'Cottage' },
  { value: 'townhouse', label: 'Townhouse' }, { value: 'other', label: 'Other' },
]

export function DetailsForm({ property }: Readonly<{ property: Property }>) {
  const action = saveDetails.bind(null, property.id)
  const [state, formAction, pending] = useActionState(action, null)

  return (
    <form action={formAction} className="space-y-5">
      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {state.error}
        </div>
      )}

      <div>
        <label htmlFor="name" className="label">Property Name <span className="text-red-500">*</span></label>
        <Input id="name" name="name" type="text" required defaultValue={property.name} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <label htmlFor="property_type" className="label">Type</label>
          <select id="property_type" name="property_type" defaultValue={property.property_type} className="input">
            {PROPERTY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="bedrooms" className="label">Bedrooms</label>
          <Input id="bedrooms" name="bedrooms" type="number" min="0" max="20" defaultValue={property.bedrooms} />
        </div>
        <div>
          <label htmlFor="bathrooms" className="label">Bathrooms</label>
          <Input id="bathrooms" name="bathrooms" type="number" min="0.5" max="20" step="0.5" defaultValue={property.bathrooms ?? ''} />
        </div>
        <div>
          <label htmlFor="square_footage" className="label">Sq Footage</label>
          <Input id="square_footage" name="square_footage" type="number" min="0" defaultValue={property.square_footage ?? ''} placeholder="e.g. 1400" />
        </div>
      </div>

      <div>
        <label htmlFor="address" className="label">Street Address</label>
        <Input id="address" name="address" type="text" defaultValue={property.address ?? ''} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1">
          <label htmlFor="city" className="label">City</label>
          <Input id="city" name="city" type="text" defaultValue={property.city ?? ''} />
        </div>
        <div>
          <label htmlFor="state" className="label">State</label>
          <Input id="state" name="state" type="text" maxLength={2} defaultValue={property.state ?? ''} />
        </div>
        <div>
          <label htmlFor="zip" className="label">ZIP</label>
          <Input id="zip" name="zip" type="text" maxLength={10} defaultValue={property.zip ?? ''} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="checkin_time" className="label">Check-in Time</label>
          <Input id="checkin_time" name="checkin_time" type="time" defaultValue={property.checkin_time} />
        </div>
        <div>
          <label htmlFor="checkout_time" className="label">Check-out Time</label>
          <Input id="checkout_time" name="checkout_time" type="time" defaultValue={property.checkout_time} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="wifi_name" className="label">Wi-Fi Name</label>
          <Input id="wifi_name" name="wifi_name" type="text" defaultValue={property.wifi_name ?? ''} />
        </div>
        <div>
          <label htmlFor="wifi_password" className="label">Wi-Fi Password</label>
          <Input id="wifi_password" name="wifi_password" type="text" defaultValue={property.wifi_password ?? ''} />
        </div>
      </div>

      <div>
        <label htmlFor="door_code" className="label">Door Code / Lockbox</label>
        <Input id="door_code" name="door_code" type="text" defaultValue={property.door_code ?? ''} />
      </div>

      <div>
        <label htmlFor="avg_nightly_rate" className="label">Average Nightly Rate ($)</label>
        <Input
          id="avg_nightly_rate"
          name="avg_nightly_rate"
          type="number"
          min="0"
          step="0.01"
          defaultValue={property.avg_nightly_rate ?? ''}
          placeholder="e.g. 285.00"
        />
        <p className="text-xs text-accent-400 mt-1">Used to automatically estimate booking revenue in the owner portal. You can always adjust individually.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="cleaning_cost" className="label">Cleaning Fee ($)</label>
          <Input
            id="cleaning_cost"
            name="cleaning_cost"
            type="number"
            min="0"
            step="0.01"
            defaultValue={property.cleaning_cost ?? ''}
            placeholder="e.g. 150.00"
          />
          <p className="text-xs text-accent-400 mt-1">Auto-posted as an expense when a turnover is completed.</p>
        </div>
        <div>
          <label htmlFor="same_day_premium_pct" className="label">Same-Day Premium (%)</label>
          <Input
            id="same_day_premium_pct"
            name="same_day_premium_pct"
            type="number"
            min="0"
            max="200"
            step="1"
            defaultValue={property.same_day_premium_pct ?? ''}
            placeholder="e.g. 25"
          />
          <p className="text-xs text-accent-400 mt-1">Added to cleaning fee when check-out and check-in are on the same day.</p>
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          name="cleaning_cost_visible_to_owner"
          defaultChecked={property.cleaning_cost_visible_to_owner}
          className="w-4 h-4 rounded"
        />
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Show cleaning fees to property owner
        </span>
      </label>

      <div>
        <label htmlFor="internal_notes" className="label">Internal Notes</label>
        <textarea id="internal_notes" name="internal_notes" rows={3} defaultValue={property.internal_notes ?? ''} className="input resize-none" placeholder="Anything crew or vendors should know…" />
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-accent-100">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save & Continue →'}
        </Button>
        <Link href="/properties" className={buttonVariantClass('ghost') + ' text-sm'}>Done for now</Link>
      </div>
    </form>
  )
}
