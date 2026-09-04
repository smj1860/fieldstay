import { ShieldCheck, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { ThumbtackPro, ThumbtackProPill } from '@/lib/integrations/thumbtack'

// ============================================================================
// The "Discovery Lite" card — richer than a bare name+rating row, built
// against the fields confirmed in Thumbtack's own design-guidelines API
// response example. Two things this card deliberately does NOT render,
// because the confirmed schema has no field for them:
//   - an avatar/photo (no image URL field exists in the confirmed response)
//   - a featured review (the design mock shows one; the actual JSON sample
//     doesn't carry review text)
// Add them once lib/integrations/thumbtack.ts's ThumbtackPro type gains the
// real fields — don't fake a placeholder photo or invented review text here.
// ============================================================================

const PILL_LABEL: Record<ThumbtackProPill, string> = {
  popular:    'Popular',
  remote:     'Remote',
  licensed:   'Licensed',
  low_price:  'Great value',
}

const PILL_TONE: Record<ThumbtackProPill, 'gold' | 'slate' | 'blue' | 'green'> = {
  popular:    'gold',
  remote:     'slate',
  licensed:   'blue',
  low_price:  'green',
}

export function formatStartingCost(cents: number): string {
  const dollars = cents / 100
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

interface ThumbtackProCardProps {
  pro: ThumbtackPro
  onSelect: () => void
}

export function ThumbtackProCard({ pro, onSelect }: Readonly<ThumbtackProCardProps>) {
  return (
    <div className="p-3 rounded-md" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{pro.businessName}</p>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {pro.rating != null && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {pro.rating.toFixed(1)}★{pro.numReviews != null ? ` (${pro.numReviews})` : ''}
              </span>
            )}
            {pro.location && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{pro.location}</span>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          className="text-xs flex items-center gap-1 flex-shrink-0"
          onClick={onSelect}
          disabled={!pro.requestFlowUrl}
          title={pro.requestFlowUrl ? undefined : 'Not available for this pro yet'}
        >
          Select &amp; Continue <ExternalLink className="w-3 h-3" />
        </Button>
      </div>

      {pro.pills && pro.pills.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {pro.pills.map((pill) => (
            <Badge key={pill} tone={PILL_TONE[pill]}>{PILL_LABEL[pill]}</Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        {pro.yearsInBusiness != null && <span>{pro.yearsInBusiness} yrs in business</span>}
        {pro.numHires != null && <span>{pro.numHires} hires on Thumbtack</span>}
        {pro.startingCostCents != null && <span>Starting at {formatStartingCost(pro.startingCostCents)}</span>}
      </div>

      {(pro.licenseVerified || pro.hasBackgroundCheck) && (
        <div className="flex items-center gap-3 flex-wrap mt-1.5 text-xs" style={{ color: 'var(--accent-green)' }}>
          {pro.licenseVerified && (
            <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> License verified</span>
          )}
          {pro.hasBackgroundCheck && (
            <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Background checked</span>
          )}
        </div>
      )}
    </div>
  )
}
