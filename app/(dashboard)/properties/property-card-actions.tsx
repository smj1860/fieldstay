'use client'

import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ClonePropertyModal } from './clone-property-modal'

interface Property {
  id: string
  name: string
}

interface CopyFromButtonProps {
  targetProperty: Property
  otherProperties: Property[]
}

export function CopyFromButton({ targetProperty, otherProperties }: Readonly<CopyFromButtonProps>) {
  const [open, setOpen] = useState(false)

  if (otherProperties.length === 0) return null

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5"
        title="Copy setup from another property"
      >
        <Copy className="w-3.5 h-3.5" />
      </Button>

      {open && (
        <ClonePropertyModal
          targetProperty={targetProperty}
          otherProperties={otherProperties}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
