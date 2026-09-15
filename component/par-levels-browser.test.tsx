import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/app/(dashboard)/templates/inventory/actions', () => ({
  upsertParLevelItems:       vi.fn(),
  deleteParLevelItem:        vi.fn(),
  cloneInventoryFromProperty: vi.fn(),
}))

import { ParLevelsBrowser } from '@/app/(dashboard)/templates/inventory/par-levels/par-levels-browser'

// ============================================================================
// The par-level input used Number.parseFloat(e.target.value) || 0 directly —
// the exact class of bug lib/inventory/quantity.ts exists to close everywhere
// else: parseFloat('2.5abc') is 2.5, silently accepting a garbage suffix, and
// `|| 0` turns ANY unparseable input into a silent 0 par, which can disable
// low-stock nudges/purchasing for that item without the PM ever seeing an
// error. This is the one live editor that had not been switched over to
// parseQuantityInput.
// ============================================================================

const PROPERTY = { id: 'prop-1', name: 'Lake House' }
const ITEM = {
  id: 'item-1', property_id: 'prop-1', catalog_item_id: 'cat-1',
  source_template_id: null, name: 'Bath Towels', category: 'bath' as const,
  unit: 'each', par_level: 2, preferred_brand: null,
}

function renderEditor() {
  render(
    <ParLevelsBrowser
      properties={[PROPERTY]}
      items={[ITEM]}
      templateNameById={{}}
      catalogItems={[]}
      canManage
    />,
  )
  fireEvent.click(screen.getByText('Lake House'))
  return screen.getByLabelText('Par level for Bath Towels') as HTMLInputElement
}

describe('ParLevelsBrowser — the par-level input', () => {
  it('rejects a garbage suffix rather than silently accepting the numeric prefix', () => {
    const input = renderEditor()
    fireEvent.change(input, { target: { value: '2.5abc' } })
    // parseFloat would have kept 2.5; parseQuantityInput rejects the whole
    // string as unparseable and falls back to 0, matching every other
    // quantity input in the app.
    expect(input.value).toBe('0')
  })

  it('accepts an ordinary decimal', () => {
    const input = renderEditor()
    fireEvent.change(input, { target: { value: '3.5' } })
    expect(input.value).toBe('3.5')
  })

  it('clamps a negative value to zero rather than storing it', () => {
    const input = renderEditor()
    fireEvent.change(input, { target: { value: '-5' } })
    expect(input.value).toBe('0')
  })

  it('quantizes excess precision to the column scale', () => {
    const input = renderEditor()
    fireEvent.change(input, { target: { value: '3.14159' } })
    expect(input.value).toBe('3.14')
  })

  it('falls back to 0 on empty input rather than leaving NaN', () => {
    const input = renderEditor()
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('0')
  })
})
