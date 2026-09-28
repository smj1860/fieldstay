import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The client imports Server Actions and two sibling buttons that do the same.
// Mocked at the module boundary: this test is about what the table RENDERS, and
// none of these are reached by paging or searching.
vi.mock('@/app/admin/prospects/actions', () => ({
  updateProspect:       vi.fn(async () => ({})),
  createProspect:       vi.fn(async () => ({ id: 'new' })),
  bulkSetStatus:        vi.fn(async () => ({})),
  triggerProspectCrawl: vi.fn(async () => ({})),
}))
vi.mock('@/app/admin/prospects/strscout-sync-button', () => ({
  StrscoutSyncButton: () => null,
}))
vi.mock('@/app/admin/prospects/pms-backfill-button', () => ({
  PmsBackfillButton: () => null,
}))
vi.mock('@/app/admin/prospects/edit-dialog', () => ({
  ProspectEditDialog: () => null,
}))

import { ProspectsClient } from '@/app/admin/prospects/prospects-client'
import type { ProspectRow } from '@/app/admin/prospects/constants'

// ============================================================================
// The prospects table rendered EVERY filtered row. The cost was not the row
// count by itself — it was what a row contains: each one carries its own status
// `<select>`, and PROSPECT_STATUSES has 14 entries, so 3,623 live accounts put
// ~50,700 `<option>` elements in the document before anyone opened a dropdown.
// Every keystroke in the search box reconciled that whole tree.
//
// These tests pin the two halves of the fix that can regress independently:
// that only one page of rows is IN THE DOM, and that everything which is
// supposed to span the whole filtered set — the count, the selection, the
// export — still does. A pagination that quietly narrowed the bulk-status
// selection or the CSV export to the visible page would be a worse bug than
// the slowness it replaced.
// ============================================================================

const PAGE_SIZE = 100

function row(i: number): ProspectRow {
  return {
    id: `p${String(i).padStart(4, '0')}`,
    company: `Company ${String(i).padStart(4, '0')}`,
    domain: null, website: null, city: null, state: null, market: null,
    portfolio_size: null, pms: null, pms_note: null,
    score_a: null, score_b: null, track: null, bucket: null,
    contact_name: null, contact_title: null, email: null,
    email_is_generic: false, email_status: 'unknown', phone: null, linkedin_url: null,
    status: 'new', status_note: null, notes: null,
    last_touch_at: null, next_action_at: null,
    comparent_url: null, last_crawled_at: null, crawl_status: null,
  } as ProspectRow
}

const ROWS = Array.from({ length: 250 }, (_, i) => row(i))

/** Company-name cells currently in the document, in render order. */
function renderedCompanies(): string[] {
  return screen.getAllByRole('button', { name: /^Edit Company/ })
    .map((b) => b.getAttribute('aria-label')!.replace('Edit ', ''))
}

describe('ProspectsClient pagination', () => {
  it('renders one page of rows, not the whole filtered set', () => {
    render(<ProspectsClient initialRows={ROWS} />)

    const companies = renderedCompanies()
    expect(companies).toHaveLength(PAGE_SIZE)
    expect(companies[0]).toBe('Company 0000')
    expect(companies[PAGE_SIZE - 1]).toBe('Company 0099')
  })

  it('keeps the status dropdowns off the DOM for rows that are not on screen', () => {
    render(<ProspectsClient initialRows={ROWS} />)

    // One per visible row. The unpaginated table put 250 here for this fixture
    // and ~3,623 in production — this count IS the defect being prevented.
    const statusSelects = screen.getAllByRole('combobox', { name: /^Status for / })
    expect(statusSelects).toHaveLength(PAGE_SIZE)
  })

  it('still reports the FULL filtered total, not the page size', () => {
    render(<ProspectsClient initialRows={ROWS} />)

    // "250 of 250 accounts" — a pagination that reported 100 here would make
    // the operator think the crawl had lost 3,500 accounts.
    expect(screen.getByText('250', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/of 250 accounts/)).toBeInTheDocument()
  })

  it('advances to the next page and lands on the following rows', async () => {
    const user = userEvent.setup()
    render(<ProspectsClient initialRows={ROWS} />)

    await user.click(screen.getByRole('button', { name: 'Next page' }))

    const companies = renderedCompanies()
    expect(companies[0]).toBe('Company 0100')
    expect(companies).toHaveLength(PAGE_SIZE)
  })

  it('shows only the remainder on the last page', async () => {
    const user = userEvent.setup()
    render(<ProspectsClient initialRows={ROWS} />)

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await user.click(screen.getByRole('button', { name: 'Next page' }))

    // 250 rows = two full pages plus 50.
    expect(renderedCompanies()).toHaveLength(50)
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('keeps a selection made on one page when you move to another', async () => {
    const user = userEvent.setup()
    render(<ProspectsClient initialRows={ROWS} />)

    await user.click(screen.getByRole('checkbox', { name: 'Select Company 0000' }))
    expect(screen.getByText(/1 selected/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next page' }))

    // The row is no longer rendered, but it is still selected — bulk status
    // applies to ids, and scoping it to the visible page would silently drop
    // work the operator had already done.
    expect(screen.queryByRole('checkbox', { name: 'Select Company 0000' })).not.toBeInTheDocument()
    expect(screen.getByText(/1 selected/)).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Set status on 1 selected accounts' }),
    ).toBeInTheDocument()
  })

  it('returns to page 1 when a search narrows the set', async () => {
    const user = userEvent.setup()
    render(<ProspectsClient initialRows={ROWS} />)

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(renderedCompanies()[0]).toBe('Company 0100')

    // Without the reset this lands on page 2 of a 1-row result — an empty
    // table for a search that matched.
    await user.type(screen.getByLabelText(/search/i), 'Company 0007')

    const companies = renderedCompanies()
    expect(companies).toContain('Company 0007')
    expect(companies.length).toBeLessThanOrEqual(PAGE_SIZE)
  })

  it('clamps rather than stranding you past the end when a filter shrinks the set', async () => {
    const user = userEvent.setup()
    render(<ProspectsClient initialRows={ROWS} />)

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await user.click(screen.getByRole('button', { name: 'Next page' }))

    // Straight to a set far smaller than the current offset. The page index is
    // derived and clamped, so this must render rows rather than an empty table.
    await user.type(screen.getByLabelText(/search/i), 'Company 0007')

    expect(renderedCompanies().length).toBeGreaterThan(0)
  })

  it('hides the pager entirely when everything fits on one page', () => {
    render(<ProspectsClient initialRows={ROWS.slice(0, 10)} />)

    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument()
    expect(screen.getByText(/Showing/)).toBeInTheDocument()
  })
})

describe('ProspectsClient table body', () => {
  it('renders the visible rows inside the table body', () => {
    render(<ProspectsClient initialRows={ROWS} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(PAGE_SIZE + 1) // + header
  })
})
