import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WidgetErrorBoundary } from '@/components/widget-error-boundary'
import { reportError } from '@/lib/observability/report-error'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

// ============================================================================
// A best-effort widget mounted unconditionally on a page (the dashboard's
// DashboardSyncBanner, say) must not be able to take the whole page down.
// Without a boundary, an uncaught render error bubbles to the nearest
// route-level error.tsx and replaces EVERYTHING — turnovers, work orders,
// every dashboard screen — over one widget's query throwing.
// ============================================================================

function Bomb(): never {
  throw new Error('boom')
}

// React logs the caught error to the console regardless of componentDidCatch
// handling it — expected noise from this specific test, not a real failure.
const silenceReactErrorLog = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('WidgetErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <WidgetErrorBoundary site="test.widget">
        <p>All good</p>
      </WidgetErrorBoundary>,
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('contains a throwing child instead of letting it propagate', () => {
    const consoleSpy = silenceReactErrorLog()
    render(
      <WidgetErrorBoundary site="test.widget">
        <Bomb />
      </WidgetErrorBoundary>,
    )
    // No fallback supplied — the widget simply disappears, not a crash.
    expect(screen.queryByText('All good')).not.toBeInTheDocument()
    consoleSpy.mockRestore()
  })

  it('renders the supplied fallback in place of the crashed subtree', () => {
    const consoleSpy = silenceReactErrorLog()
    render(
      <WidgetErrorBoundary site="test.widget" fallback={<p>Widget unavailable</p>}>
        <Bomb />
      </WidgetErrorBoundary>,
    )
    expect(screen.getByText('Widget unavailable')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })

  it('reports the caught error as a WARNING, not a silent swallow', () => {
    const consoleSpy = silenceReactErrorLog()
    render(
      <WidgetErrorBoundary site="dashboard.sync-banner">
        <Bomb />
      </WidgetErrorBoundary>,
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({ site: 'dashboard.sync-banner', level: 'warning' }),
    )
    consoleSpy.mockRestore()
  })

  it('does not contain a sibling outside the boundary — only its own children', () => {
    const consoleSpy = silenceReactErrorLog()
    render(
      <>
        <WidgetErrorBoundary site="test.widget">
          <Bomb />
        </WidgetErrorBoundary>
        <p>Rest of the page</p>
      </>,
    )
    expect(screen.getByText('Rest of the page')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})
