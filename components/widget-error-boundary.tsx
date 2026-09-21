'use client'

import { Component, type ReactNode } from 'react'
import { reportError } from '@/lib/observability/report-error'

// Isolates a non-critical widget from the page it sits on.
//
// React has no hook form of this — componentDidCatch only exists on a class
// component, so this is one of the few class components in the app, kept as
// small and boring as possible.
//
// WITHOUT ONE: an uncaught render error anywhere inside `children` bubbles up
// to the nearest route-level error.tsx, which replaces the WHOLE page with a
// generic "try again" card. That is the right failure mode for a page whose
// own data failed to load. It is the wrong one for a best-effort side widget
// mounted unconditionally on every screen — DashboardSyncBanner, the
// dashboard's dead-letter surface, is exactly this: a useLiveQuery that opens
// IndexedDB can throw (a private window, blocked site data — see CLAUDE.md's
// crew_availability note on this), and that must cost the PM one missing
// status pill, never the entire dashboard underneath it.

interface Props {
  /** Dot-separated site id, passed straight to reportError(). */
  site: string
  children: ReactNode
  /** Rendered in place of the crashed subtree. Defaults to nothing. */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error): void {
    // A warning, not an error: the boundary did exactly what it exists to do
    // — contained the failure — so this is a signal worth seeing, not an
    // unhandled crash. See CLAUDE.md's "Report severity" note.
    reportError(error, { site: this.props.site, level: 'warning' })
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null
    return this.props.children
  }
}
