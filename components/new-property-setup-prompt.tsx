'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Home, X } from 'lucide-react'
import { ClonePropertyModal } from '@/app/(dashboard)/properties/clone-property-modal'

interface OtherProperty {
  id:   string
  name: string
}

interface NewPropertySetupPromptProps {
  milestone:       string
  propertyId:      string
  propertyName:    string
  otherProperties: OtherProperty[]
}

export function NewPropertySetupPrompt({
  milestone,
  propertyId,
  propertyName,
  otherProperties,
}: Readonly<NewPropertySetupPromptProps>) {
  const [hidden, setHidden]         = useState(false)
  const [cloneOpen, setCloneOpen]   = useState(false)

  if (hidden) return null

  async function handleDismiss() {
    await fetch('/api/milestones/dismiss', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ milestone }),
    }).catch(() => {})
    setHidden(true)
  }

  return (
    <div
      className="flex items-center gap-3 rounded-xl px-4 py-3 mb-6"
      style={{ background: 'var(--accent-blue-dim)', border: '1px solid var(--border-strong)' }}
    >
      <Home className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent-blue)' }} />
      <p className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold">New property &ldquo;{propertyName}&rdquo; was just synced.</span>
        {' '}Set up its checklist, inventory, and maintenance schedule before your first turnover.
      </p>
      <div className="flex items-center gap-2 flex-shrink-0">
        {otherProperties.length > 0 && (
          <button type="button" onClick={() => setCloneOpen(true)} className="btn-secondary text-xs px-3 py-1.5">
            Clone from existing property
          </button>
        )}
        <Link href={`/properties/${propertyId}/setup/details`} className="btn-cta text-xs px-3 py-1.5">
          Set up from scratch
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          className="p-1"
          style={{ color: 'var(--text-muted)' }}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {cloneOpen && (
        <ClonePropertyModal
          targetProperty={{ id: propertyId, name: propertyName }}
          otherProperties={otherProperties}
          onClose={() => setCloneOpen(false)}
        />
      )}
    </div>
  )
}
