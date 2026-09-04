'use client'

import { useState } from 'react'
import { Search, ExternalLink, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { RequestFlowModal } from '@/components/thumbtack/RequestFlowModal'
import { searchThumbtackProsAction, recordThumbtackRequestCreatedAction } from '@/lib/integrations/thumbtack-actions'
import type { ThumbtackCategoryKey, ThumbtackPro } from '@/lib/integrations/thumbtack'
import type { ThumbtackRfEvent } from '@/lib/integrations/thumbtack-events'

// ============================================================================
// "Find a Pro on Thumbtack" — a clearly-separated section, never mixed into
// FieldStay's own vendor/crew lists (Thumbtack's Do's & Don'ts: don't blend
// content from the API with other sources). Only rendered by callers when
// isThumbtackConfigured() is true (see the three page call sites), so this
// component can assume the feature is live and just handle the per-search
// failure cases (unmapped category, network error).
// ============================================================================

interface FindProOnThumbtackSectionProps {
  categoryKey: ThumbtackCategoryKey
  /** Null when the surface has no natural per-item zip (e.g. the Crew page — see its call site for why). */
  zipCode: string | null
  /** e.g. "plumber", "house cleaner" — used only in copy, not sent to Thumbtack. */
  categoryLabel: string
  /** Set only from Work Order detail — the one surface with a specific WO to attach the record to. */
  workOrderId?: string | null
}

type RequestCreatedInfo = Extract<ThumbtackRfEvent, { type: 'THUMBTACK_RF_REQUEST_CREATED' }>['data']

export function FindProOnThumbtackSection({ categoryKey, zipCode, categoryLabel, workOrderId = null }: Readonly<FindProOnThumbtackSectionProps>) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [pros, setPros]       = useState<ThumbtackPro[] | null>(null)
  const [selectedPro, setSelectedPro] = useState<ThumbtackPro | null>(null)
  // Set only on a real THUMBTACK_RF_REQUEST_CREATED event — a plain close
  // (via the X or "Got it") leaves this null, so a completed request and an
  // abandoned one render differently rather than looking identical.
  const [completed, setCompleted] = useState<RequestCreatedInfo | null>(null)

  async function handleSearch() {
    setLoading(true)
    setError(null)
    const result = await searchThumbtackProsAction(categoryKey, zipCode)
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setPros(result.pros)
  }

  function handleRequestCreated(data: RequestCreatedInfo) {
    setCompleted(data)
    void recordThumbtackRequestCreatedAction(workOrderId, data)
  }

  if (completed) {
    return (
      <Card className="p-4">
        <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
          <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--accent-green)' }} />
          Request sent on Thumbtack
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Contacted {completed.businesses_contacted.length === 1
            ? completed.businesses_contacted[0]!.business_name
            : `${completed.businesses_contacted.length} businesses`}. They&apos;ll reach out directly — this doesn&apos;t create anything in FieldStay.
        </p>
      </Card>
    )
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <Search className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
            No {categoryLabel} on hand? Find one on Thumbtack
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            By continuing you&apos;ll be directed to Thumbtack to request a quote.
          </p>
        </div>
        {pros === null && (
          <Button variant="secondary" onClick={handleSearch} disabled={loading} className="text-sm flex-shrink-0">
            {loading ? 'Searching…' : 'Find a Pro'}
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs mt-3" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      {pros !== null && (
        <div className="mt-3 space-y-2">
          {pros.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No pros found for this area yet.</p>
          ) : (
            pros.map((pro) => (
              <div
                key={pro.businessPk}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-md"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
              >
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{pro.businessName}</p>
                  {pro.rating != null && (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {pro.rating.toFixed(1)}★{pro.numReviews != null ? ` (${pro.numReviews})` : ''}
                    </p>
                  )}
                </div>
                <Button variant="secondary" className="text-xs flex items-center gap-1" onClick={() => setSelectedPro(pro)}>
                  Select &amp; Continue <ExternalLink className="w-3 h-3" />
                </Button>
              </div>
            ))
          )}
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Powered by Thumbtack</p>
        </div>
      )}

      <RequestFlowModal
        requestFlowUrl={selectedPro?.requestFlowUrl ?? null}
        open={selectedPro !== null}
        onClose={() => setSelectedPro(null)}
        onRequestCreated={handleRequestCreated}
      />
    </Card>
  )
}
