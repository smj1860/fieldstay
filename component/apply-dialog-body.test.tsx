import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ApplyDialogBody } from '@/app/(dashboard)/templates/maintenance/create/apply-dialog-body'
import type { BroadcastResult } from '@/app/(dashboard)/maintenance/maintenance-template-actions'

// ============================================================================
// BroadcastResult is one type covering both the success and error shapes
// broadcastMaintenanceTemplate() can return ({ error?, success?, created?,
// skipped? }). ApplyDialogBody's own caller today always routes an
// `{error}` response through a separate `applyError` prop instead of
// storing it as `applyResult` — but nothing in this component enforced
// that. A future or different caller storing the raw error response would
// have rendered "Template applied — Created undefined schedules", actively
// lying to the PM about the outcome.
// ============================================================================

const BASE_PROPS = {
  properties:            [],
  applyMode:             'all' as const,
  onApplyModeChange:     () => {},
  selectedPropertyIds:   [],
  onToggleProperty:      () => {},
  allPropertiesSelected: false,
  onToggleAllProperties: () => {},
}

describe('ApplyDialogBody', () => {
  it('renders the success summary for a real success result', () => {
    const result: BroadcastResult = { success: true, created: 3, skipped: 1 }
    render(<ApplyDialogBody {...BASE_PROPS} applyResult={result} />)
    expect(screen.getByText('Template applied')).toBeInTheDocument()
    expect(screen.getByText(/Created 3 schedules/)).toBeInTheDocument()
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument()
  })

  it('renders an error, not a false success, when applyResult carries an error', () => {
    const result: BroadcastResult = { error: 'Failed to broadcast template' }
    render(<ApplyDialogBody {...BASE_PROPS} applyResult={result} />)
    expect(screen.queryByText('Template applied')).not.toBeInTheDocument()
    expect(screen.queryByText(/Created/)).not.toBeInTheDocument()
    expect(screen.getByText('Failed to broadcast template')).toBeInTheDocument()
  })

  it('renders a generic error rather than a false success when success is not explicitly true', () => {
    // No `error` string and no `success: true` — the shape a caller storing
    // an incomplete or malformed response would produce. Must not fall
    // through to the success branch just because `error` is unset.
    const result = {} as BroadcastResult
    render(<ApplyDialogBody {...BASE_PROPS} applyResult={result} />)
    expect(screen.queryByText('Template applied')).not.toBeInTheDocument()
    expect(screen.getByText('Could not apply the template. Please try again.')).toBeInTheDocument()
  })
})
