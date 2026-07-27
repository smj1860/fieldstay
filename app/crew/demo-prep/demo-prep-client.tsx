'use client'

import { useCallback, useState } from 'react'
import { Check, X, RefreshCw, WifiOff, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useDexieDb } from '@/lib/dexie/context'
import {
  checkDemoOfflineReadiness,
  type DemoReadinessReport,
} from '@/lib/dexie/demo-readiness'

/**
 * "Prep for Demo" screen — run this on wifi before the booth.
 *
 * The offline demo's whole credibility rests on the local cache being warm
 * before the phone loses network. This makes that a checked assertion rather
 * than an assumption, and shows the green badge only when every required
 * check actually passes.
 */
export function DemoPrepClient() {
  const db = useDexieDb()

  const [report,  setReport]  = useState<DemoReadinessReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const runCheck = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      setReport(await checkDemoOfflineReadiness(db))
    } catch (err) {
      // Distinguish a failed check from a failing check — an IndexedDB error
      // is an outage, not a "not ready yet", and must not render as a
      // reassuring red X in a list that otherwise looks like it ran.
      setError(err instanceof Error ? err.message : 'Could not read the local cache.')
      setReport(null)
    } finally {
      setRunning(false)
    }
  }, [db])

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Prep for Demo
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Run this on wifi before going offline. It checks that everything the
          checklist and inventory screens need is already stored on this device.
        </p>
      </header>

      <Button variant="primary" onClick={runCheck} disabled={running} className="w-full">
        <span className="inline-flex items-center justify-center gap-2">
          <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} aria-hidden="true" />
          {running ? 'Checking…' : 'Run readiness check'}
        </span>
      </Button>

      {error !== null && (
        <Card>
          <div className="flex items-start gap-3 p-4">
            <AlertTriangle
              className="w-5 h-5 flex-shrink-0 mt-0.5"
              style={{ color: 'var(--accent-red)' }}
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Check could not run
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{error}</p>
            </div>
          </div>
        </Card>
      )}

      {report !== null && <ReadinessBanner ready={report.ready} />}

      {report !== null && (
        <Card>
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {report.checks.map((check) => (
              <li key={check.label} className="flex items-start gap-3 p-3">
                {check.ok
                  ? <Check className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-green)' }} aria-hidden="true" />
                  : <X     className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-red)' }}   aria-hidden="true" />}
                <div className="min-w-0">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    <span className="sr-only">{check.ok ? 'Passed: ' : 'Failed: '}</span>
                    {check.label}
                  </p>
                  {check.detail !== undefined && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {check.detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="p-4 space-y-2">
          <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <WifiOff className="w-4 h-4" aria-hidden="true" />
            Before the booth
          </p>
          <ol className="text-sm space-y-1.5 list-decimal pl-5" style={{ color: 'var(--text-secondary)' }}>
            <li>Open Turnovers, Checklists, and Inventory once each while on wifi.</li>
            <li>Run the readiness check above until every line is green.</li>
            <li>Put the phone in real airplane mode and complete a full checklist end to end.</li>
            <li>Turn wifi back on and confirm the queued writes flush.</li>
          </ol>
        </div>
      </Card>
    </div>
  )
}

function ReadinessBanner({ ready }: Readonly<{ ready: boolean }>) {
  const tone = ready ? 'var(--accent-green)' : 'var(--accent-amber)'
  return (
    <output
      className="rounded-lg p-3 flex items-center gap-3"
      style={{ background: 'var(--bg-raised)', border: `1px solid ${tone}` }}
    >
      {ready
        ? <Check className="w-5 h-5 flex-shrink-0" style={{ color: tone }} aria-hidden="true" />
        : <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: tone }} aria-hidden="true" />}
      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        {ready
          ? 'Fully synced — safe for offline demo'
          : 'Not ready — resolve the items below before going offline'}
      </p>
    </output>
  )
}
