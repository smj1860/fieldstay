import { describe, it, expect } from 'vitest'
import { pickDemoInventorySelection } from '@/lib/demo/seed'

describe('pickDemoInventorySelection', () => {
  it('caps each category at 2 items', () => {
    const items = [
      { category: 'paper_goods', name: 'A' },
      { category: 'paper_goods', name: 'B' },
      { category: 'paper_goods', name: 'C' },
      { category: 'cleaning',    name: 'D' },
    ]
    const picked = pickDemoInventorySelection(items)

    expect(picked.filter((i) => i.category === 'paper_goods')).toHaveLength(2)
    expect(picked.filter((i) => i.category === 'cleaning')).toHaveLength(1)
  })

  it('keeps the first 2 items encountered per category, in order', () => {
    const items = [
      { category: 'kitchen', name: 'First' },
      { category: 'kitchen', name: 'Second' },
      { category: 'kitchen', name: 'Third' },
    ]
    const picked = pickDemoInventorySelection(items)

    expect(picked.map((i) => i.name)).toEqual(['First', 'Second'])
  })

  it('returns an empty array for an empty catalog', () => {
    expect(pickDemoInventorySelection([])).toEqual([])
  })

  it('spans every distinct category present in the input', () => {
    const items = [
      { category: 'paper_goods', name: 'A' },
      { category: 'cleaning',    name: 'B' },
      { category: 'kitchen',     name: 'C' },
      { category: 'bath',        name: 'D' },
    ]
    const picked = pickDemoInventorySelection(items)

    expect(new Set(picked.map((i) => i.category))).toEqual(
      new Set(['paper_goods', 'cleaning', 'kitchen', 'bath'])
    )
  })
})
