import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { CategoryPickerFindProSection } from '@/components/thumbtack/CategoryPickerFindProSection'

// ============================================================================
// categoryOptions[0]!.value used to run inside useState's initializer, which
// evaluates on the very first render regardless of any guard placed after
// it — a caller building this list dynamically (filtered to categories
// relevant to a specific property type) that happens to land on zero entries
// took down whatever page mounted this, before any user interaction.
// ============================================================================

describe('CategoryPickerFindProSection', () => {
  it('renders nothing rather than crashing when given an empty categoryOptions array', () => {
    expect(() =>
      render(
        <CategoryPickerFindProSection
          heading="Find a pro"
          categoryOptions={[]}
          categoryFieldLabel="Category"
        />,
      ),
    ).not.toThrow()
  })

  it('still renders the picker normally with a real categoryOptions list', () => {
    render(
      <CategoryPickerFindProSection
        heading="Find a pro"
        categoryOptions={[{ value: 'plumbing', label: 'Plumbing' }]}
        categoryFieldLabel="Category"
      />,
    )
    expect(screen.getByText('Find a pro')).toBeInTheDocument()
    expect(screen.getByLabelText('Category')).toBeInTheDocument()
  })
})
