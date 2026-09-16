'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { FindProOnThumbtackSection } from '@/components/thumbtack/FindProOnThumbtackSection'
import type { ThumbtackCategoryKey } from '@/lib/integrations/thumbtack'

// ============================================================================
// Shared by the Crew and Maintenance list pages — both need a category + zip
// picked before a search makes sense, unlike Work Order detail, which already
// has both from the WO/property. Kept as ONE component parameterized by
// `categoryOptions` rather than two near-copies (the mistake this exact repo
// caught itself making with lib/history/loadPropertyHistory.ts's six
// query blocks — see that file's header comment).
// ============================================================================

interface CategoryPickerFindProSectionProps {
  heading: string
  categoryOptions: { value: ThumbtackCategoryKey; label: string }[]
  categoryFieldLabel: string
}

export function CategoryPickerFindProSection({ heading, categoryOptions, categoryFieldLabel }: Readonly<CategoryPickerFindProSectionProps>) {
  // categoryOptions[0]!.value was a lie the moment a caller passes []: a
  // future caller building this list dynamically (e.g. filtered to categories
  // relevant to a specific property type) could land on zero entries, and the
  // non-null assertion would throw during the very first render — before any
  // user interaction, taking down whatever page mounted this. The initializer
  // itself must stay safe (Rules of Hooks — this can't be guarded by an early
  // return before the hook runs), so it takes the optional value and the
  // empty case is handled by the guard below instead.
  const [category, setCategory] = useState<ThumbtackCategoryKey | undefined>(categoryOptions[0]?.value)
  const [zip, setZip]           = useState('')
  const [confirmedZip, setConfirmedZip] = useState<string | null>(null)

  if (categoryOptions.length === 0 || category === undefined) return null

  // inputMode="numeric" is a soft-keyboard hint only — it does not stop a
  // desktop user, a password manager, or a paste from putting anything in
  // this field. A length check alone lets "aaaaa" or "-----" through.
  const isValidZip = /^\d{5}$/.test(zip.trim())

  if (confirmedZip) {
    const label = categoryOptions.find((c) => c.value === category)?.label.toLowerCase() ?? 'pro'
    return <FindProOnThumbtackSection categoryKey={category} zipCode={confirmedZip} categoryLabel={label} />
  }

  return (
    <Card className="p-4">
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{heading}</p>
      <div className="flex items-end gap-3 mt-3 flex-wrap">
        <div>
          <label htmlFor="thumbtack-category" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            {categoryFieldLabel}
          </label>
          <select
            id="thumbtack-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as ThumbtackCategoryKey)}
            className="text-sm rounded-md px-2 py-1.5"
            style={{ border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
          >
            {categoryOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="thumbtack-zip" className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            Zip code
          </label>
          <input
            id="thumbtack-zip"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            placeholder="90210"
            inputMode="numeric"
            className="text-sm rounded-md px-2 py-1.5 w-24"
            style={{ border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
          />
        </div>
        <Button
          variant="secondary"
          className="text-sm"
          disabled={!isValidZip}
          onClick={() => setConfirmedZip(zip.trim())}
        >
          Search
        </Button>
      </div>
    </Card>
  )
}
